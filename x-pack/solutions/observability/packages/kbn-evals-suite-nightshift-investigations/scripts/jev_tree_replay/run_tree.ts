/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DecisionNodeView } from '@kbn/nightshift-decision-trees';
import { edgeOptions, nodeById, symptomRoots } from './compile_tree';
import type {
  BoundEvidence,
  BranchChooser,
  CompiledTree,
  EdgeOption,
  EscalationReason,
  Hop,
  NoneRule,
  WalkResult,
} from './types';

const MAX_HOPS = 40;
const EVIDENCE_WINDOW = 4;

/** Produces the evidence for one evidence-gatherer node: replayed from a capture, or gathered live. */
export type EvidenceGatherer = (node: DecisionNodeView) => Promise<BoundEvidence>;

export interface ConfidencePolicy {
  threshold: number;
  margin: number;
}

export interface WalkInput {
  tree: CompiledTree;
  question: string;
  gather: EvidenceGatherer;
  chooser: BranchChooser;
  /** When set, the first hop asks whether the alert matches the tree's symptom at all. */
  symptomGate: boolean;
  /**
   * `every_hop` lets `none_of_these` end the walk at any branch; `entry_only` honours it only at
   * the symptom gate and leaves in-tree escalation to the confidence threshold.
   */
  noneRule: NoneRule;
  /**
   * Escalates as soon as a branch falls below the policy, so a live walk stops gathering evidence.
   * Replays leave it unset and apply thresholds afterwards with {@link applyThreshold}.
   */
  stopBelow?: ConfidencePolicy;
}

const isConfident = (
  probabilities: Record<string, number>,
  { threshold, margin }: ConfidencePolicy
): boolean => {
  const [best = 0, runnerUp = 0] = Object.values(probabilities).sort((a, b) => b - a);
  return best >= threshold && best - runnerUp >= margin;
};

/**
 * Walks the tree taking the most probable edge at every branch, stopping when the chooser says
 * none of the edges fit (off tree), confidence drops below `stopBelow`, or the graph dead-ends.
 */
export const walkTree = async ({
  tree,
  question,
  gather,
  chooser,
  symptomGate,
  noneRule,
  stopBelow,
}: WalkInput): Promise<WalkResult> => {
  const { view, goldPath } = tree;
  const hops: Hop[] = [];
  const evidence: BoundEvidence[] = [];
  const path: string[] = [];
  let evidenceMissing = 0;
  let latency = 0;

  const finish = (
    result: Pick<
      WalkResult,
      'outcome' | 'escalation_reason' | 'terminal_node_id' | 'terminal_label'
    >
  ): WalkResult => ({
    ...result,
    path,
    hops,
    evidence,
    evidence_missing: evidenceMissing,
    chooser_latency_ms: latency,
  });

  const choose = async (
    nodeId: string,
    label: string,
    options: EdgeOption[]
  ): Promise<{ target?: string; reason?: EscalationReason }> => {
    const decision = await chooser({
      question,
      decisionLabel: label,
      evidence: evidence.slice(-EVIDENCE_WINDOW),
      options,
    });
    latency += decision.latency_ms;
    const isEntry = nodeId === 'entry';
    const best = decision.chosen ? decision.probabilities[decision.chosen] ?? 0 : 0;
    const honourNone = isEntry || noneRule === 'every_hop';
    const taken = !honourNone || best >= decision.none_probability ? decision.chosen : undefined;
    hops.push({ node_id: nodeId, options, decision, taken });
    if (!taken) return { reason: isEntry ? 'symptom_mismatch' : 'off_tree' };
    if (stopBelow && !isConfident(decision.probabilities, stopBelow)) {
      return { reason: isEntry ? 'symptom_mismatch' : 'low_confidence' };
    }
    return { target: options.find(({ key }) => key === taken)?.target_node_id };
  };

  const roots = symptomRoots(view);
  let current: string | undefined = goldPath[0] ?? roots[0]?.node_id;
  if (symptomGate) {
    const { target, reason } = await choose(
      'entry',
      'Does this alert describe the same symptom as one of these known symptoms?',
      roots.map(({ node_id: id, label }, index) => ({
        key: `symptom_${index}`,
        target_node_id: id,
        condition: label,
      }))
    );
    if (reason) return finish({ outcome: 'escalated', escalation_reason: reason });
    current = target;
  }

  while (current && path.length < MAX_HOPS) {
    if (path.includes(current)) break;
    path.push(current);
    const node = nodeById(view, current);
    if (!node) break;
    if (node.node_type === 'evidence_gatherer') {
      const bound = await gather(node);
      if (bound.observations.length === 0) evidenceMissing++;
      evidence.push(bound);
    }
    const options = edgeOptions(view, current);
    if (options.length === 0) {
      return node.node_type === 'end'
        ? finish({
            outcome: 'resolved',
            terminal_node_id: node.node_id,
            terminal_label: node.label,
          })
        : finish({ outcome: 'escalated', escalation_reason: 'dead_end' });
    }
    if (options.length === 1) {
      current = options[0].target_node_id;
      continue;
    }
    const { target, reason } = await choose(node.node_id, node.label, options);
    if (reason) return finish({ outcome: 'escalated', escalation_reason: reason });
    current = target;
  }
  return finish({ outcome: 'escalated', escalation_reason: 'dead_end' });
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
    if (!isConfident(decision.probabilities, { threshold, margin })) {
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
