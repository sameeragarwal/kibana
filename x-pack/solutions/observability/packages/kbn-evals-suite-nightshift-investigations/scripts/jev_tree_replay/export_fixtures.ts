/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ConversationRound } from '@kbn/agent-builder-common';
import type {
  GetDecisionTreeResponse,
  GetInvestigationResponse,
  ListDecisionTreesResponse,
} from '@kbn/nightshift-investigations-plugin/common';
import { symptomSlugFromTreeId } from '@kbn/nightshift-decision-trees';
import type { ToolingLog } from '@kbn/tooling-log';
import { extractToolCallTrajectory } from '../../evals/investigation/tool_call_trajectory';
import { kibanaFetch, type KibanaTarget } from './kibana_client';
import type { CaseFixture, CaseTree } from './types';

const MAX_RESULT_CHARS = 20_000;

interface RunLogLine {
  case_id: string;
  investigation_id?: string;
  conversation_id?: string;
  scores?: Record<string, number | null>;
}

interface ExamplesFile {
  examples: Array<{
    input: { question: string };
    output?: { reference_answer?: string };
    metadata: { case_id: string };
  }>;
}

/** Pulls the per-run summary lines the investigation spec logs (one JSON object per run). */
const readRunLines = (logPath: string): RunLogLine[] =>
  readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const start = line.indexOf('{"experiment_id"');
      if (start === -1) return [];
      try {
        return [JSON.parse(line.slice(start)) as RunLogLine];
      } catch {
        return [];
      }
    });

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  );

const overlap = (a: string, b: string): number => {
  const right = words(b);
  return [...words(a)].filter((word) => right.has(word)).length;
};

/**
 * Snapshots each exploration run (report, tool-call trajectory, timing, judge scores) and the
 * decision tree reinforcement wrote for it, so the replay runs offline from these files alone.
 */
export const exportFixtures = async ({
  target,
  logPath,
  examplesPath,
  outDir,
  log,
}: {
  target: KibanaTarget;
  logPath: string;
  examplesPath: string;
  outDir: string;
  log: ToolingLog;
}): Promise<CaseFixture[]> => {
  const examples = (JSON.parse(readFileSync(examplesPath, 'utf8')) as ExamplesFile).examples;
  const runs = readRunLines(logPath);
  if (runs.length === 0) throw new Error(`No run summary lines found in ${logPath}`);

  const { trees: summaries } = await kibanaFetch<ListDecisionTreesResponse>(
    target,
    '/internal/nightshift/decision_trees'
  );
  const trees = await Promise.all(
    summaries.map(async ({ tree_id: treeId }) => {
      const { tree } = await kibanaFetch<GetDecisionTreeResponse>(
        target,
        `/internal/nightshift/decision_trees/${encodeURIComponent(symptomSlugFromTreeId(treeId))}`
      );
      return tree;
    })
  );
  log.info(`Found ${trees.length} decision tree(s): ${trees.map((t) => t.tree_id).join(', ')}`);

  mkdirSync(outDir, { recursive: true });
  const fixtures: CaseFixture[] = [];
  for (const run of runs) {
    const example = examples.find(({ metadata }) => metadata.case_id === run.case_id);
    if (!example || !run.investigation_id) continue;
    const investigation = await kibanaFetch<GetInvestigationResponse>(
      target,
      `/internal/nightshift/investigations/${encodeURIComponent(run.investigation_id)}`
    );
    const conversationId = run.conversation_id ?? investigation.conversation_id;
    const rounds = conversationId
      ? (
          await kibanaFetch<{ rounds: ConversationRound[] }>(
            target,
            `/api/agent_builder/conversations/${encodeURIComponent(conversationId)}`,
            { apiVersion: '2023-10-31' }
          )
        ).rounds
      : [];
    const startedAt = investigation.started_at ?? investigation.created_at;
    const ranked = trees
      .map((tree) => ({
        tree,
        score: overlap(`${tree.symptom} ${tree.title}`, example.input.question),
      }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const tree: CaseTree | undefined =
      best && best.score > 0
        ? {
            tree_id: best.tree.tree_id,
            symptom: best.tree.symptom,
            title: best.tree.title,
            version: best.tree.version,
            markdown: best.tree.markdown,
            evidence_gatherer_metadata: best.tree.evidence_gatherer_metadata,
            attribution: 'reinforcement',
          }
        : undefined;
    const { conclusion, summary, severity, hypotheses, recommendations } = investigation;
    const fixture: CaseFixture = {
      case_id: run.case_id,
      question: example.input.question,
      reference_answer: example.output?.reference_answer,
      investigation_id: run.investigation_id,
      conversation_id: conversationId,
      generative_duration_ms:
        investigation.completed_at && startedAt
          ? Date.parse(investigation.completed_at) - Date.parse(startedAt)
          : undefined,
      generative_scores: run.scores ?? {},
      report: { conclusion, summary, severity, hypotheses, recommendations },
      trajectory: extractToolCallTrajectory(rounds).map((step) => ({
        ...step,
        result: step.result.slice(0, MAX_RESULT_CHARS),
      })),
      tree,
    };
    writeFileSync(join(outDir, `${run.case_id}.json`), JSON.stringify(fixture, null, 2), {
      mode: 0o600,
    });
    log.info(
      `${run.case_id}: ${fixture.trajectory.length} tool calls, tree=${tree?.tree_id ?? 'none'} ` +
        `(overlap ${best?.score ?? 0})`
    );
    fixtures.push(fixture);
  }
  return fixtures;
};
