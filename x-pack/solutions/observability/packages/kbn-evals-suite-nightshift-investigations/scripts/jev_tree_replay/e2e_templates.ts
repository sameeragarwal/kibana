/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pMap from 'p-map';
import type { ToolingLog } from '@kbn/tooling-log';
import { composeAnswerText } from '../../evals/investigation/judges/scoring';
import { nodeById } from './compile_tree';
import { writeUp, type ArmResult } from './e2e';
import { createLiveGatherer, ensureEvidenceAgent } from './evidence_agent';
import { judgeGoalPass, type GoalVerdict, type KibanaTarget } from './kibana_client';
import {
  createTemplateGatherer,
  extractIncidentParams,
  type CompiledQueries,
  type TemplateStepRecord,
} from './query_templates';
import { walkTree, type ConfidencePolicy } from './run_tree';
import type { TelemetryTarget } from './telemetry_client';
import type { BranchChooser, CaseFixture, CompiledTree, WalkResult } from './types';

interface ScoredAnswer {
  answer: string;
  duration_ms: number;
  verdict?: GoalVerdict;
  input_tokens: number;
  output_tokens: number;
}

export interface TemplateRunResult {
  case_id: string;
  rep: number;
  walk?: WalkResult;
  steps: TemplateStepRecord[];
  walk_ms: number;
  /** Agent tokens spent on steps whose compiled queries all failed. */
  agent_fallback_tokens: number;
  /** The walk escalated, so both answers are the generative run's. */
  escalated: boolean;
  /** Decision path plus evidence tables, no model at all. */
  templated?: ScoredAnswer;
  /** Same walk, one Sonnet call writes the conclusion. */
  written?: ScoredAnswer;
  error?: string;
}

const firstRows = (result: string, rows: number): string =>
  result
    .split('\n')
    .slice(0, rows + 1)
    .join('; ');

/** Renders the walk as a report with no model: the reached leaf, the branch path, and the data. */
const templatedAnswer = (tree: CompiledTree, walk: WalkResult): string => {
  const path = walk.hops
    .filter(({ taken, node_id: id }) => taken && id !== 'entry')
    .map(({ node_id: id, options, taken, decision }) => {
      const label = nodeById(tree.view, id)?.label ?? id;
      const condition = options.find(({ key }) => key === taken)?.condition;
      return `${label} -> ${condition} (p=${decision.probabilities[taken!]?.toFixed(2)})`;
    });
  const evidence = walk.evidence.map(
    ({ label, observations }) =>
      `${label}: ${observations
        .map(({ command, result }) => `${command.split('\n')[0]}: ${firstRows(result, 3)}`)
        .join(' | ')}`
  );
  return composeAnswerText({
    conclusion: walk.terminal_label ?? '',
    summary: [`Decision path: ${path.join('; ')}.`, `Evidence: ${evidence.join(' || ')}`].join(
      '\n'
    ),
  });
};

/**
 * Walks each incident's compiled tree with compiled ES|QL evidence (no model) and Jev decisions,
 * then answers twice: templated, and with one Sonnet write-up. Escalations use the generative run.
 */
export const runTemplateEndToEnd = async ({
  fixtures,
  compiled,
  queries,
  jev,
  target,
  connectorId,
  telemetry,
  telemetryConnectorId,
  agentFallback,
  policy,
  repetitions,
  log,
}: {
  fixtures: CaseFixture[];
  compiled: Map<string, CompiledTree>;
  queries: Map<string, CompiledQueries>;
  jev: BranchChooser;
  target: KibanaTarget;
  connectorId: string;
  telemetry: TelemetryTarget;
  telemetryConnectorId: string;
  agentFallback: boolean;
  policy: ConfidencePolicy;
  repetitions: number;
  log: ToolingLog;
}): Promise<TemplateRunResult[]> => {
  if (agentFallback) await ensureEvidenceAgent(target, telemetryConnectorId);

  const runOne = async (fixture: CaseFixture, rep: number): Promise<TemplateRunResult> => {
    const tree = compiled.get(fixture.case_id);
    const compiledQueries = queries.get(fixture.case_id);
    const result: TemplateRunResult = {
      case_id: fixture.case_id,
      rep,
      steps: [],
      walk_ms: 0,
      agent_fallback_tokens: 0,
      escalated: false,
    };
    if (!tree || !compiledQueries) {
      result.error = 'no compiled tree or queries';
      return result;
    }
    const live = agentFallback
      ? createLiveGatherer({ target, connectorId, question: fixture.question })
      : undefined;
    const templates = createTemplateGatherer({
      compiled: compiledQueries,
      params: extractIncidentParams(fixture.question),
      telemetry,
      fallback: live?.gather,
    });
    const started = performance.now();
    try {
      const walk = await walkTree({
        tree,
        question: fixture.question,
        gather: templates.gather,
        chooser: jev,
        symptomGate: true,
        noneRule: 'entry_only',
        stopBelow: policy,
      });
      result.walk = walk;
      result.walk_ms = performance.now() - started;
      result.steps = templates.steps;
      result.agent_fallback_tokens = (live?.steps ?? []).reduce(
        (sum, { input_tokens: input, output_tokens: output }) => sum + input + output,
        0
      );
      if (walk.outcome === 'escalated') {
        result.escalated = true;
        const fallback: ScoredAnswer = {
          answer: composeAnswerText(fixture.report),
          duration_ms: result.walk_ms + (fixture.generative_duration_ms ?? 0),
          input_tokens: 0,
          output_tokens: 0,
        };
        result.templated = { ...fallback };
        result.written = { ...fallback };
      } else {
        result.templated = {
          answer: templatedAnswer(tree, walk),
          duration_ms: result.walk_ms,
          input_tokens: 0,
          output_tokens: 0,
        };
        const writeStarted = performance.now();
        const written = await writeUp(target, connectorId, {
          tree,
          walk,
          question: fixture.question,
        });
        result.written = {
          answer: composeAnswerText(written),
          duration_ms: result.walk_ms + (performance.now() - writeStarted),
          input_tokens: written.input_tokens,
          output_tokens: written.output_tokens,
        };
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.walk_ms = performance.now() - started;
    }
    log.info(
      `templates ${fixture.case_id.slice(10, 50)} #${rep}: ${
        result.walk?.outcome ?? result.error
      } ${result.walk?.terminal_node_id ?? result.walk?.escalation_reason ?? ''} in ${Math.round(
        result.walk_ms
      )}ms`
    );
    return result;
  };

  const jobs = fixtures.flatMap((fixture) =>
    Array.from({ length: repetitions }, (_, rep) => () => runOne(fixture, rep))
  );
  const results = await pMap(jobs, (job) => job(), { concurrency: 5 });

  const byCase = new Map(fixtures.map((fixture) => [fixture.case_id, fixture]));
  const toJudge = results.flatMap((result) =>
    [result.templated, result.written].flatMap((scored) =>
      scored?.answer ? [{ fixture: byCase.get(result.case_id)!, scored }] : []
    )
  );
  await pMap(
    toJudge,
    async ({ fixture, scored }) => {
      scored.verdict = await judgeGoalPass(target, connectorId, {
        question: fixture.question,
        reference: fixture.reference_answer ?? '',
        answer: scored.answer,
      });
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
const time = (ms: number | undefined): string => {
  if (ms === undefined) return '-';
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
};
const short = (caseId: string): string =>
  caseId.replace(/^customer0-/, '').replace(/-2026-.*$/, '');
const kTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;

interface Row {
  label: string;
  verdicts: Array<GoalVerdict | undefined>;
  durations: number[];
  /** Model tokens spent per incident at investigation time (input + output). */
  tokens: number[];
}

const row = ({ label, verdicts, durations, tokens }: Row): string => {
  const scored = verdicts.filter((verdict): verdict is GoalVerdict => Boolean(verdict));
  const mean = scored.reduce((sum, { raw_score: s }) => sum + (s ?? 0), 0) / (scored.length || 1);
  return `| ${label} | ${scored.filter(({ passed }) => passed).length}/${
    verdicts.length
  } | ${mean.toFixed(1)} | ${time(median(durations))} | ${
    tokens.length ? kTokens(median(tokens) ?? 0) : 'not captured'
  } |`;
};

/** Compares compiled-query evidence against the earlier Sonnet-evidence run and the baselines. */
export const renderTemplateSummary = ({
  results,
  queries,
  previous,
  policy,
  repetitions,
}: {
  results: TemplateRunResult[];
  queries: Map<string, CompiledQueries>;
  previous: ArmResult[];
  policy: ConfidencePolicy;
  repetitions: number;
}): string => {
  const sonnetEvidence = previous.filter(({ arm }) => arm === 'compiled_tree_jev');
  const sonnetTokens = (result: ArmResult) =>
    (result.evidence_steps ?? []).reduce(
      (sum, { input_tokens: input, output_tokens: output }) => sum + input + output,
      0
    );
  const resolved = (result: TemplateRunResult) => !result.escalated && !result.error;
  const lines = [
    '# Evidence without a generative model: compiled ES|QL + Jev',
    '',
    `Each tree's evidence steps were compiled once, offline, into ES|QL templates (one Sonnet call plus one repair pass per tree). At investigation time the templates are filled from the alert text with regexes, run directly against the telemetry cluster, and Jev reads the raw tables. Same walk policy as before: symptom gate on, escalate below T=${policy.threshold} or margin ${policy.margin}, escalations fall back to the generative run. ${repetitions} repetition(s) per incident; the Sonnet-evidence rows are the single earlier run.`,
    '',
    'Token column: median model tokens spent per incident at investigation time, excluding the generative fallback on escalation (which is the same for every tree arm).',
    '',
    '| arm | goal_pass passed | mean score (1-5) | median time | runtime model tokens |',
    '| --- | --- | --- | --- | --- |',
    row({
      label: 'compiled ES|QL + Jev, templated answer (no runtime model)',
      verdicts: results.map(({ templated }) => templated?.verdict),
      durations: results.map(({ templated }) => templated?.duration_ms ?? 0),
      tokens: results.map(({ agent_fallback_tokens: t }) => t),
    }),
    row({
      label: 'compiled ES|QL + Jev + one Sonnet write-up',
      verdicts: results.map(({ written }) => written?.verdict),
      durations: results.map(({ written }) => written?.duration_ms ?? 0),
      tokens: results.map(
        ({ agent_fallback_tokens: t, written }) =>
          t + (written?.input_tokens ?? 0) + (written?.output_tokens ?? 0)
      ),
    }),
    row({
      label: 'Sonnet evidence agent + Jev + Sonnet write-up (earlier run)',
      verdicts: sonnetEvidence.map(({ verdict }) => verdict),
      durations: sonnetEvidence.map(({ duration_ms: ms }) => ms),
      tokens: sonnetEvidence.map(sonnetTokens),
    }),
    ...(['tree_in_prompt', 'generative_no_tree'] as const).map((arm) =>
      row({
        label: `${arm} (earlier run)`,
        verdicts: previous.filter((r) => r.arm === arm).map(({ verdict }) => verdict),
        durations: previous.filter((r) => r.arm === arm).map(({ duration_ms: ms }) => ms),
        tokens: [],
      })
    ),
    '',
    '## Per incident',
    '',
    '| incident | compiled ES|QL walk (path, time) | templated | + Sonnet write-up | Sonnet evidence (earlier) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const caseId of [...new Set(results.map(({ case_id: id }) => id))]) {
    const runs = results.filter(({ case_id: id }) => id === caseId);
    const scores = (pick: (r: TemplateRunResult) => ScoredAnswer | undefined) =>
      runs.map((r) => pick(r)?.verdict?.raw_score ?? '-').join(',');
    const walks = runs
      .map((r) =>
        r.error
          ? 'error'
          : r.escalated
          ? `escalated (${r.walk?.escalation_reason})`
          : `${r.walk?.path.filter((id) => /^[EX]/.test(id)).join('>')} ${time(r.walk_ms)}`
      )
      .join('; ');
    const earlier = sonnetEvidence.find(({ case_id: id }) => id === caseId);
    const earlierCell = earlier
      ? `${earlier.verdict?.raw_score ?? '-'}/5, ${time(earlier.duration_ms)}, ${
          earlier.fell_back
            ? `escalated (${earlier.walk?.escalation_reason})`
            : `via ${earlier.walk?.terminal_node_id}`
        }`
      : '-';
    lines.push(
      `| ${short(caseId)} | ${walks} | ${scores((r) => r.templated)} | ${scores(
        (r) => r.written
      )} | ${earlierCell} |`
    );
  }

  lines.push('', '## Walks (first repetition)', '');
  for (const result of results.filter(({ rep }) => rep === 0)) {
    const steps = result.steps
      .map(
        ({ node_id: id, queries: qs, duration_ms: ms, fell_back_to_agent: agent }) =>
          `${id} ${time(ms)} [${qs.map(({ status, rows }) => `${status}:${rows}`).join(' ')}]${
            agent ? ' -> agent' : ''
          }`
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
    lines.push(
      `- **${short(result.case_id)}**: ${result.walk?.outcome ?? result.error}${
        resolved(result) ? ` at ${result.walk?.terminal_node_id}` : ''
      }. Evidence: ${steps || 'none'}. Jev ${Math.round(
        result.walk?.chooser_latency_ms ?? 0
      )}ms. Hops: ${hops}`
    );
  }

  lines.push('', '## Offline compile (once per tree)', '');
  lines.push('| tree | LLM calls | tokens | time | queries: rows / empty / error |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const compiledQueries of queries.values()) {
    const { compile, validation } = compiledQueries;
    const count = (status: string) => validation.filter((v) => v.status === status).length;
    lines.push(
      `| ${short(compiledQueries.case_id)} | ${compile.llm_calls} | ${kTokens(
        compile.input_tokens + compile.output_tokens
      )} | ${time(compile.duration_ms)} | ${count('rows')} / ${count('empty')} / ${count(
        'error'
      )} |`
    );
  }
  lines.push('');
  return lines.join('\n');
};
