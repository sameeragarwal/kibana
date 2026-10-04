/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { setTimeout } from 'timers/promises';
import pMap from 'p-map';
import type { ToolingLog } from '@kbn/tooling-log';
import type { GetInvestigationResponse } from '@kbn/nightshift-investigations-plugin/common';
import { composeAnswerText } from '../../evals/investigation/judges/scoring';
import { nodeById } from './compile_tree';
import { createLiveGatherer, ensureEvidenceAgent, type EvidenceStepRecord } from './evidence_agent';
import { judgeGoalPass, kibanaFetch, type GoalVerdict, type KibanaTarget } from './kibana_client';
import { walkTree, type ConfidencePolicy } from './run_tree';
import type { BranchChooser, CaseFixture, CompiledTree, WalkResult } from './types';

const INVESTIGATION_TIMEOUT_MS = 20 * 60_000;

export type ArmName = 'compiled_tree_jev' | 'tree_in_prompt' | 'generative_no_tree';

export interface ArmResult {
  arm: ArmName;
  case_id: string;
  /** Wall-clock time to an answer, including any fallback investigation. */
  duration_ms: number;
  answer: string;
  verdict?: GoalVerdict;
  investigation_id?: string;
  error?: string;
  /** compiled_tree_jev only. */
  walk?: WalkResult;
  evidence_steps?: EvidenceStepRecord[];
  evidence_conversation_id?: string;
  fell_back?: boolean;
  walk_ms?: number;
  writeup_ms?: number;
}

const report = (investigation: GetInvestigationResponse) => {
  const { summary, conclusion, severity, hypotheses, recommendations, impact } = investigation;
  return { summary, conclusion, severity, hypotheses, recommendations, impact };
};

/** Starts a Nightshift investigation and polls it to a terminal status. */
const runInvestigation = async (
  target: KibanaTarget,
  message: string
): Promise<{ investigation: GetInvestigationResponse; id: string; durationMs: number }> => {
  const started = Date.now();
  const { investigation_id: id } = await kibanaFetch<{ investigation_id: string }>(
    target,
    '/internal/nightshift/investigations',
    { method: 'POST', body: { subject: { type: 'manual' }, message } }
  );
  const path = `/internal/nightshift/investigations/${encodeURIComponent(id)}`;
  for (;;) {
    const investigation = await kibanaFetch<GetInvestigationResponse>(target, path);
    if (investigation.status !== 'pending' && investigation.status !== 'running') {
      return { investigation, id, durationMs: Date.now() - started };
    }
    if (Date.now() - started > INVESTIGATION_TIMEOUT_MS) {
      throw new Error(`Investigation ${id} did not finish within 20 minutes`);
    }
    await setTimeout(5_000);
  }
};

const treePrompt = (fixture: CaseFixture): string => {
  const { tree } = fixture;
  if (!tree) return fixture.question;
  return [
    fixture.question,
    '',
    'A decision tree learned from a previous investigation of this symptom is below. Follow it:',
    'gather the evidence each step names, use the evidence to choose the branch, and conclude at a',
    'leaf. If the evidence does not fit any branch, investigate beyond the tree.',
    '',
    '```mermaid',
    tree.markdown.trim(),
    '```',
    '',
    'Evidence steps:',
    ...tree.evidence_gatherer_metadata.map((line) => `- ${line}`),
  ].join('\n');
};

interface WriteUp {
  conclusion: string;
  summary: string;
  input_tokens: number;
  output_tokens: number;
}

/** One Sonnet call turns the decision path and gathered findings into a short RCA report. */
export const writeUp = async (
  target: KibanaTarget,
  connectorId: string,
  { tree, walk, question }: { tree: CompiledTree; walk: WalkResult; question: string }
): Promise<WriteUp> => {
  const path = walk.hops
    .filter(({ taken }) => taken)
    .map(({ node_id: id, options, taken }) => ({
      decision: id === 'entry' ? 'Symptom' : nodeById(tree.view, id)?.label ?? id,
      chosen: options.find(({ key }) => key === taken)?.condition,
    }));
  const response = await kibanaFetch<{
    toolCalls?: Array<{ function: { arguments: Partial<WriteUp> } }>;
    tokens?: { prompt?: number; completion?: number };
  }>(target, '/internal/inference/chat_complete', {
    method: 'POST',
    body: {
      connectorId,
      temperature: 0,
      system:
        'You write the root-cause conclusion of an incident investigation. A known decision procedure was followed: you get its decision path, the leaf it reached, and the evidence gathered at each step. State the root cause the evidence supports, citing specific numbers and timestamps. Do not invent evidence; if the evidence contradicts the leaf, say so.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            incident: question,
            reached_leaf: walk.terminal_label,
            decision_path: path,
            evidence: walk.evidence.map(({ label, observations }) => ({
              step: label,
              findings: observations.map(({ result }) => result).join('\n'),
            })),
          }),
        },
      ],
      tools: {
        report: {
          description: 'Report the investigation result.',
          schema: {
            type: 'object',
            properties: {
              conclusion: { type: 'string', description: 'The root cause, in 1-3 sentences.' },
              summary: {
                type: 'string',
                description: 'The supporting evidence, in 2-5 sentences.',
              },
            },
            required: ['conclusion', 'summary'],
          },
        },
      },
      toolChoice: { function: 'report' },
    },
  });
  const args = response.toolCalls?.[0]?.function.arguments ?? {};
  return {
    conclusion: args.conclusion ?? walk.terminal_label ?? '',
    summary: args.summary ?? '',
    input_tokens: response.tokens?.prompt ?? 0,
    output_tokens: response.tokens?.completion ?? 0,
  };
};

/**
 * Runs each incident end to end three ways: the compiled tree with live Sonnet evidence and Jev
 * branch decisions (falling back to the generative investigation on escalation), a generative
 * investigation with the tree in its prompt, and the original generative run with no tree.
 */
export const runEndToEnd = async ({
  fixtures,
  compiled,
  jev,
  target,
  connectorId,
  telemetryConnectorId,
  policy,
  log,
}: {
  fixtures: CaseFixture[];
  compiled: Map<string, CompiledTree>;
  jev: BranchChooser;
  target: KibanaTarget;
  connectorId: string;
  telemetryConnectorId: string;
  policy: ConfidencePolicy;
  log: ToolingLog;
}): Promise<ArmResult[]> => {
  await ensureEvidenceAgent(target, telemetryConnectorId);
  const judge = (fixture: CaseFixture, answer: string) =>
    judgeGoalPass(target, connectorId, {
      question: fixture.question,
      reference: fixture.reference_answer ?? '',
      answer,
    });

  const noTree = (fixture: CaseFixture): ArmResult => ({
    arm: 'generative_no_tree',
    case_id: fixture.case_id,
    duration_ms: fixture.generative_duration_ms ?? 0,
    answer: composeAnswerText(fixture.report),
    investigation_id: fixture.investigation_id,
  });

  const compiledArm = async (fixture: CaseFixture): Promise<ArmResult> => {
    const tree = compiled.get(fixture.case_id);
    const started = performance.now();
    const live = createLiveGatherer({ target, connectorId, question: fixture.question });
    const result: ArmResult = {
      arm: 'compiled_tree_jev',
      case_id: fixture.case_id,
      duration_ms: 0,
      answer: '',
    };
    try {
      if (!tree) throw new Error('no compiled tree');
      const walk = await walkTree({
        tree,
        question: fixture.question,
        gather: live.gather,
        chooser: jev,
        symptomGate: true,
        noneRule: 'entry_only',
        stopBelow: policy,
      });
      result.walk = walk;
      result.walk_ms = performance.now() - started;
      if (walk.outcome === 'resolved') {
        const writeStarted = performance.now();
        result.answer = composeAnswerText(
          await writeUp(target, connectorId, { tree, walk, question: fixture.question })
        );
        result.writeup_ms = performance.now() - writeStarted;
        result.duration_ms = performance.now() - started;
      } else {
        const fallback = noTree(fixture);
        result.fell_back = true;
        result.answer = fallback.answer;
        result.investigation_id = fallback.investigation_id;
        result.duration_ms = result.walk_ms + fallback.duration_ms;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.duration_ms = performance.now() - started;
    }
    result.evidence_steps = live.steps;
    result.evidence_conversation_id = live.conversationId();
    log.info(
      `compiled ${fixture.case_id.slice(10, 50)}: ${result.walk?.outcome ?? 'error'} ` +
        `${result.walk?.terminal_label ?? result.walk?.escalation_reason ?? result.error ?? ''} ` +
        `(${live.steps.length} evidence steps, ${Math.round((result.walk_ms ?? 0) / 1000)}s walk)`
    );
    return result;
  };

  const promptArm = async (fixture: CaseFixture): Promise<ArmResult> => {
    const started = Date.now();
    try {
      const { investigation, id, durationMs } = await runInvestigation(target, treePrompt(fixture));
      log.info(
        `tree_in_prompt ${fixture.case_id.slice(10, 50)}: ${investigation.status} in ${Math.round(
          durationMs / 1000
        )}s`
      );
      return {
        arm: 'tree_in_prompt',
        case_id: fixture.case_id,
        duration_ms: durationMs,
        answer: composeAnswerText(report(investigation)),
        investigation_id: id,
        ...(investigation.status === 'completed'
          ? {}
          : { error: investigation.error || `investigation ${investigation.status}` }),
      };
    } catch (error) {
      return {
        arm: 'tree_in_prompt',
        case_id: fixture.case_id,
        duration_ms: Date.now() - started,
        answer: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const jobs = fixtures.flatMap((fixture) => [
    () => compiledArm(fixture),
    () => promptArm(fixture),
    async () => noTree(fixture),
  ]);
  const results = await pMap(jobs, (job) => job(), { concurrency: 10 });

  const byCase = new Map(fixtures.map((fixture) => [fixture.case_id, fixture]));
  await pMap(
    results.filter(({ answer }) => answer),
    async (result) => {
      result.verdict = await judge(byCase.get(result.case_id)!, result.answer);
    },
    { concurrency: 4 }
  );
  return results;
};

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const secs = (ms: number | undefined): string =>
  ms === undefined ? '-' : `${Math.round(ms / 1000)}s`;
const short = (caseId: string): string =>
  caseId.replace(/^customer0-/, '').replace(/-2026-.*$/, '');

/** Renders the end-to-end comparison as markdown. */
export const renderEndToEndSummary = (results: ArmResult[], policy: ConfidencePolicy): string => {
  const arms: ArmName[] = ['compiled_tree_jev', 'tree_in_prompt', 'generative_no_tree'];
  const lines = [
    '# End-to-end: compiled tree (Sonnet evidence + Jev decisions) vs generative',
    '',
    `Compiled arm: symptom gate on, escalate below T=${policy.threshold} or margin ${policy.margin}; on escalation it falls back to the generative (no tree) run and pays its time.`,
    '',
    '| arm | goal_pass passed | mean score (1-5) | median time | errors |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const arm of arms) {
    const rows = results.filter((result) => result.arm === arm);
    const scored = rows.filter(({ verdict }) => verdict);
    const mean =
      scored.reduce((sum, { verdict }) => sum + (verdict?.raw_score ?? 0), 0) /
      (scored.length || 1);
    lines.push(
      `| ${arm} | ${scored.filter(({ verdict }) => verdict?.passed).length}/${
        rows.length
      } | ${mean.toFixed(1)} | ${secs(median(rows.map(({ duration_ms: ms }) => ms)))} | ${
        rows.filter(({ error }) => error).length
      } |`
    );
  }
  lines.push('', '## Per incident', '');
  lines.push('| incident | compiled tree (Jev) | tree in prompt | generative, no tree |');
  lines.push('| --- | --- | --- | --- |');
  for (const caseId of [...new Set(results.map(({ case_id: id }) => id))]) {
    const cell = (arm: ArmName): string => {
      const result = results.find((r) => r.arm === arm && r.case_id === caseId);
      if (!result) return '-';
      const score = result.verdict ? `${result.verdict.raw_score}/5` : result.error ? 'error' : '-';
      const extra =
        arm === 'compiled_tree_jev' && result.walk
          ? result.fell_back
            ? `, escalated (${result.walk.escalation_reason}) -> fallback`
            : `, resolved via ${result.walk.terminal_node_id}`
          : '';
      return `${score}, ${secs(result.duration_ms)}${extra}`;
    };
    lines.push(
      `| ${short(caseId)} | ${cell('compiled_tree_jev')} | ${cell('tree_in_prompt')} | ${cell(
        'generative_no_tree'
      )} |`
    );
  }
  lines.push('', '## Compiled-tree walks', '');
  for (const result of results.filter(({ arm }) => arm === 'compiled_tree_jev')) {
    const steps = (result.evidence_steps ?? [])
      .map(
        ({ node_id: id, duration_ms: ms, tool_calls: calls, error }) =>
          `${id} ${secs(ms)}/${calls} calls${error ? ' ERROR' : ''}`
      )
      .join(', ');
    const hops = (result.walk?.hops ?? [])
      .map(({ node_id: id, decision, taken }) => {
        const best = taken ? decision.probabilities[taken] : undefined;
        return `${id}:${
          taken ? `${taken}@${best?.toFixed(2)}` : 'none'
        }(none=${decision.none_probability.toFixed(2)})`;
      })
      .join(' ');
    const jevMs = Math.round(result.walk?.chooser_latency_ms ?? 0);
    lines.push(
      `- **${short(result.case_id)}**: ${result.walk?.outcome ?? result.error}. Evidence: ${
        steps || 'none'
      }. Jev total ${jevMs}ms. Hops: ${hops}`
    );
  }
  lines.push('');
  return lines.join('\n');
};
