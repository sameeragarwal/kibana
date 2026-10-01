/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TrajectoryStep } from '../../evals/investigation/types';
import { bindEvidence } from './bind_evidence';
import { edgeOptions, nodeById, symptomRoots } from './compile_tree';
import type {
  BoundEvidence,
  BranchChooser,
  CompiledTree,
  EdgeOption,
  Hop,
  NoneRule,
  WalkResult,
} from './types';

const MAX_HOPS = 40;
const EVIDENCE_WINDOW = 4;

export interface WalkInput {
  tree: CompiledTree;
  question: string;
  trajectory: TrajectoryStep[];
  chooser: BranchChooser;
  /** When set, the first hop asks whether the alert matches the tree's symptom at all. */
  symptomGate: boolean;
  /**
   * `every_hop` lets `none_of_these` end the walk at any branch; `entry_only` honours it only at
   * the symptom gate and leaves in-tree escalation to the confidence threshold.
   */
  noneRule: NoneRule;
}

/**
 * Walks the tree taking the most probable edge at every branch, stopping only when the chooser
 * says none of the edges fit (off tree) or the graph dead-ends. Confidence thresholds are applied
 * afterwards by {@link applyThreshold}, so one walk serves a whole threshold sweep.
 */
export const walkTree = async ({
  tree,
  question,
  trajectory,
  chooser,
  symptomGate,
  noneRule,
}: WalkInput): Promise<WalkResult> => {
  const { view, goldPath } = tree;
  const hops: Hop[] = [];
  const evidence: BoundEvidence[] = [];
  const path: string[] = [];
  let evidenceMissing = 0;
  let latency = 0;

  const choose = async (nodeId: string, label: string, options: EdgeOption[]) => {
    const decision = await chooser({
      question,
      decisionLabel: label,
      evidence: evidence.slice(-EVIDENCE_WINDOW),
      options,
    });
    latency += decision.latency_ms;
    const best = decision.chosen ? decision.probabilities[decision.chosen] ?? 0 : 0;
    const honourNone = nodeId === 'entry' || noneRule === 'every_hop';
    const taken = !honourNone || best >= decision.none_probability ? decision.chosen : undefined;
    hops.push({ node_id: nodeId, options, decision, taken });
    return options.find(({ key }) => key === taken)?.target_node_id;
  };

  const roots = symptomRoots(view);
  let current: string | undefined;
  if (symptomGate) {
    current = await choose(
      'entry',
      'Does this alert describe the same symptom as one of these known symptoms?',
      roots.map(({ node_id: id, label }, index) => ({
        key: `symptom_${index}`,
        target_node_id: id,
        condition: label,
      }))
    );
    if (!current) {
      return {
        outcome: 'escalated',
        escalation_reason: 'symptom_mismatch',
        path,
        hops,
        evidence_missing: 0,
        chooser_latency_ms: latency,
      };
    }
  } else {
    current = goldPath[0] ?? roots[0]?.node_id;
  }

  while (current && path.length < MAX_HOPS) {
    if (path.includes(current)) break;
    path.push(current);
    const node = nodeById(view, current);
    if (!node) break;
    if (node.node_type === 'evidence_gatherer') {
      const bound = bindEvidence(node, trajectory);
      if (bound.observations.length === 0) evidenceMissing++;
      evidence.push(bound);
    }
    const options = edgeOptions(view, current);
    if (options.length === 0) {
      return {
        outcome: node.node_type === 'end' ? 'resolved' : 'escalated',
        ...(node.node_type === 'end'
          ? { terminal_node_id: node.node_id, terminal_label: node.label }
          : { escalation_reason: 'dead_end' as const }),
        path,
        hops,
        evidence_missing: evidenceMissing,
        chooser_latency_ms: latency,
      };
    }
    if (options.length === 1) {
      current = options[0].target_node_id;
      continue;
    }
    const next = await choose(node.node_id, node.label, options);
    if (!next) {
      return {
        outcome: 'escalated',
        escalation_reason: 'off_tree',
        path,
        hops,
        evidence_missing: evidenceMissing,
        chooser_latency_ms: latency,
      };
    }
    current = next;
  }
  return {
    outcome: 'escalated',
    escalation_reason: 'dead_end',
    path,
    hops,
    evidence_missing: evidenceMissing,
    chooser_latency_ms: latency,
  };
};

/** Re-reads a walk under a confidence policy: escalate at the first hop below threshold or margin. */
export const applyThreshold = (
  walk: WalkResult,
  threshold: number,
  margin: number
): Pick<WalkResult, 'outcome' | 'escalation_reason' | 'terminal_node_id' | 'terminal_label'> & {
  decided_hops: number;
} => {
  for (const [index, { decision, taken }] of walk.hops.entries()) {
    if (!taken) break;
    const ranked = Object.values(decision.probabilities).sort((a, b) => b - a);
    const [best = 0, runnerUp = 0] = ranked;
    if (best < threshold || best - runnerUp < margin) {
      return {
        outcome: 'escalated',
        escalation_reason:
          index === 0 && walk.hops[0].node_id === 'entry' ? 'symptom_mismatch' : 'low_confidence',
        decided_hops: index,
      };
    }
  }
  return {
    outcome: walk.outcome,
    escalation_reason: walk.escalation_reason,
    terminal_node_id: walk.terminal_node_id,
    terminal_label: walk.terminal_label,
    decided_hops: walk.hops.filter(({ taken }) => taken).length,
  };
};

/** The answer text a resolved walk would hand back: the terminal, plus the branch reasoning. */
export const composeWalkAnswer = (tree: CompiledTree, walk: WalkResult): string => {
  const steps = walk.hops
    .filter(({ taken }) => taken)
    .map(({ node_id: id, options, taken }) => {
      const label = id === 'entry' ? 'Symptom' : nodeById(tree.view, id)?.label ?? id;
      const condition = options.find(({ key }) => key === taken)?.condition;
      return `- ${label}: ${condition}`;
    });
  return [`Conclusion: ${walk.terminal_label ?? 'none'}`, 'Decision path:', ...steps].join('\n');
};
