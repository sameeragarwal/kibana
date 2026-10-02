/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pMap from 'p-map';
import type { ToolingLog } from '@kbn/tooling-log';
import { GOAL_PASS_THRESHOLD } from '../../evals/investigation/judges/scoring';
import { bindEvidence } from './bind_evidence';
import { judgeGoalPass, type GoalVerdict, type KibanaTarget } from './kibana_client';
import { applyThreshold, composeWalkAnswer, walkTree } from './run_tree';
import type { BranchChooser, CaseFixture, CompiledTree, NoneRule, WalkResult } from './types';

export const THRESHOLDS = [0, 0.5, 0.6, 0.7, 0.8, 0.9] as const;
const NONE_RULES: readonly NoneRule[] = ['every_hop', 'entry_only'];
export const MARGIN = 0.1;
const NORMALIZED_PASS = (GOAL_PASS_THRESHOLD - 1) / 4;

export interface MatrixCell {
  chooser: string;
  symptom_gate: boolean;
  none_rule: NoneRule;
  tree_case_id: string;
  incident_case_id: string;
  diagonal: boolean;
  gold_path: string[];
  walk: WalkResult;
  /** Judge verdict on the argmax answer, for resolved walks only. */
  verdict?: GoalVerdict;
  matches_gold_terminal?: boolean;
}

export interface TreeDiagnostics {
  case_id: string;
  tree_id: string;
  nodes: number;
  edges: number;
  branching_nodes: number;
  gold_path_length: number;
  gold_terminal?: string;
  /** Does the terminal exploration itself reached pass goal_pass? Upper bound for the runner. */
  gold_verdict?: GoalVerdict;
}

const percentile = (values: number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export const runMatrix = async ({
  fixtures,
  compiled,
  choosers,
  target,
  judgeConnectorId,
  log,
}: {
  fixtures: CaseFixture[];
  compiled: Map<string, CompiledTree>;
  choosers: Record<string, BranchChooser>;
  target: KibanaTarget;
  judgeConnectorId: string;
  log: ToolingLog;
}): Promise<{ cells: MatrixCell[]; trees: TreeDiagnostics[] }> => {
  const jobs = Object.entries(choosers).flatMap(([chooserName, chooser]) =>
    [true, false].flatMap((symptomGate) =>
      NONE_RULES.flatMap((noneRule) =>
        [...compiled.entries()].flatMap(([treeCaseId, tree]) =>
          fixtures.map((incident) => ({
            chooserName,
            chooser,
            symptomGate,
            noneRule,
            treeCaseId,
            tree,
            incident,
          }))
        )
      )
    )
  );
  log.info(`Walking ${jobs.length} (chooser x gate x none rule x tree x incident) cells`);
  const cells = await pMap(
    jobs,
    async ({ chooserName, chooser, symptomGate, noneRule, treeCaseId, tree, incident }) => {
      const walk = await walkTree({
        tree,
        question: incident.question,
        gather: async (node) => bindEvidence(node, incident.trajectory),
        chooser,
        symptomGate,
        noneRule,
      });
      const goldTerminal = tree.goldPath.at(-1);
      const cell: MatrixCell = {
        chooser: chooserName,
        symptom_gate: symptomGate,
        none_rule: noneRule,
        tree_case_id: treeCaseId,
        incident_case_id: incident.case_id,
        diagonal: treeCaseId === incident.case_id,
        gold_path: tree.goldPath,
        walk,
        matches_gold_terminal:
          walk.outcome === 'resolved' ? walk.terminal_node_id === goldTerminal : undefined,
      };
      log.info(
        `${chooserName} gate=${symptomGate} none=${noneRule} tree=${treeCaseId.slice(
          10,
          40
        )} incident=${incident.case_id.slice(10, 40)} ` +
          `-> ${walk.outcome}${
            walk.terminal_label ? ` "${walk.terminal_label}"` : ` (${walk.escalation_reason})`
          } ` +
          `hops=${walk.hops.length} ${Math.round(walk.chooser_latency_ms)}ms`
      );
      return cell;
    },
    { concurrency: 4 }
  );

  const verdictCache = new Map<string, Promise<GoalVerdict>>();
  const judge = (incident: CaseFixture, answer: string) => {
    const key = `${incident.case_id}\n${answer}`;
    if (!verdictCache.has(key)) {
      verdictCache.set(
        key,
        judgeGoalPass(target, judgeConnectorId, {
          question: incident.question,
          reference: incident.reference_answer ?? '',
          answer,
        })
      );
    }
    return verdictCache.get(key)!;
  };
  const byCase = new Map(fixtures.map((fixture) => [fixture.case_id, fixture]));
  await pMap(
    cells.filter(({ walk }) => walk.outcome === 'resolved'),
    async (cell) => {
      const incident = byCase.get(cell.incident_case_id)!;
      if (!incident.reference_answer) return;
      cell.verdict = await judge(
        incident,
        composeWalkAnswer(compiled.get(cell.tree_case_id)!, cell.walk)
      );
    },
    { concurrency: 4 }
  );

  const trees = await pMap([...compiled.entries()], async ([caseId, tree]) => {
    const incident = byCase.get(caseId)!;
    const goldTerminalId = tree.goldPath.at(-1);
    const goldTerminal = tree.view.nodes.find(({ node_id: id }) => id === goldTerminalId);
    const branching = tree.view.nodes.filter(
      ({ node_id: id }) => tree.view.edges.filter(({ source_node_id: s }) => s === id).length > 1
    ).length;
    return {
      case_id: caseId,
      tree_id: tree.tree_id,
      nodes: tree.view.nodes.length,
      edges: tree.view.edges.length,
      branching_nodes: branching,
      gold_path_length: tree.goldPath.length,
      gold_terminal: goldTerminal?.label,
      gold_verdict:
        goldTerminal?.node_type === 'end' && incident.reference_answer
          ? await judge(incident, `Conclusion: ${goldTerminal.label}`)
          : undefined,
    };
  });
  return { cells, trees };
};

export interface SweepRow {
  chooser: string;
  symptom_gate: boolean;
  none_rule: NoneRule;
  threshold: number;
  diagonal_coverage: number;
  diagonal_selective_accuracy?: number;
  diagonal_accuracy: number;
  diagonal_gold_terminal_agreement?: number;
  off_diagonal_false_resolution_rate: number;
  off_diagonal_escalation_recall: number;
}

const rate = (num: number, den: number): number => (den === 0 ? 0 : num / den);

/** Applies each confidence threshold to the recorded walks and computes the headline metrics. */
export const sweep = (cells: MatrixCell[]): SweepRow[] => {
  const groups = new Map<string, MatrixCell[]>();
  for (const cell of cells) {
    const key = `${cell.chooser}|${cell.symptom_gate}|${cell.none_rule}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups.entries()].flatMap(([key, group]) => {
    const [chooser, gate, noneRule] = key.split('|');
    return THRESHOLDS.map((threshold) => {
      const outcomes = group.map((cell) => ({
        cell,
        policy: applyThreshold(cell.walk, threshold, threshold === 0 ? 0 : MARGIN),
      }));
      const diagonal = outcomes.filter(({ cell }) => cell.diagonal);
      const off = outcomes.filter(({ cell }) => !cell.diagonal);
      const resolvedDiag = diagonal.filter(({ policy }) => policy.outcome === 'resolved');
      const correctDiag = resolvedDiag.filter(
        ({ cell }) => (cell.verdict?.score ?? 0) >= NORMALIZED_PASS
      );
      const resolvedOff = off.filter(({ policy }) => policy.outcome === 'resolved');
      return {
        chooser,
        symptom_gate: gate === 'true',
        none_rule: noneRule as NoneRule,
        threshold,
        diagonal_coverage: rate(resolvedDiag.length, diagonal.length),
        diagonal_selective_accuracy:
          resolvedDiag.length > 0 ? rate(correctDiag.length, resolvedDiag.length) : undefined,
        diagonal_accuracy: rate(correctDiag.length, diagonal.length),
        diagonal_gold_terminal_agreement:
          resolvedDiag.length > 0
            ? rate(
                resolvedDiag.filter(({ cell }) => cell.matches_gold_terminal).length,
                resolvedDiag.length
              )
            : undefined,
        off_diagonal_false_resolution_rate: rate(resolvedOff.length, off.length),
        off_diagonal_escalation_recall: rate(off.length - resolvedOff.length, off.length),
      };
    });
  });
};

export const latencySummary = (cells: MatrixCell[], fixtures: CaseFixture[]) => {
  const byChooser = new Map<string, number[]>();
  const perCall = new Map<string, number[]>();
  const tokens = new Map<string, number>();
  for (const { chooser, walk } of cells) {
    byChooser.set(chooser, [...(byChooser.get(chooser) ?? []), walk.chooser_latency_ms]);
    for (const { decision } of walk.hops) {
      perCall.set(chooser, [...(perCall.get(chooser) ?? []), decision.latency_ms]);
      tokens.set(
        chooser,
        (tokens.get(chooser) ?? 0) + (decision.input_tokens ?? 0) + (decision.output_tokens ?? 0)
      );
    }
  }
  const generative = fixtures.flatMap(({ generative_duration_ms: ms }) => (ms ? [ms] : []));
  return {
    walk_ms: Object.fromEntries(
      [...byChooser].map(([name, values]) => [
        name,
        { p50: percentile(values, 50), p95: percentile(values, 95) },
      ])
    ),
    per_call_ms: Object.fromEntries(
      [...perCall].map(([name, values]) => [
        name,
        { p50: percentile(values, 50), p95: percentile(values, 95), calls: values.length },
      ])
    ),
    tokens: Object.fromEntries(tokens),
    generative_ms: { p50: percentile(generative, 50), p95: percentile(generative, 95) },
  };
};
