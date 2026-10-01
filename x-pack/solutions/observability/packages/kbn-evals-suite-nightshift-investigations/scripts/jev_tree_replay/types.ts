/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DecisionTreeView } from '@kbn/nightshift-decision-trees';
import type { InvestigationStructuredOutput } from '@kbn/nightshift-investigations-plugin/common';
import type { TrajectoryStep } from '../../evals/investigation/types';

/** Everything one exploration run left behind, captured once so replays need no live stack. */
export interface CaseFixture {
  case_id: string;
  question: string;
  reference_answer?: string;
  investigation_id: string;
  conversation_id?: string;
  /** Wall-clock time of the generative investigation, from start to completion. */
  generative_duration_ms?: number;
  /** Judge scores the exploration run recorded, keyed by evaluator name. */
  generative_scores: Record<string, number | null>;
  report?: InvestigationStructuredOutput;
  trajectory: TrajectoryStep[];
  tree?: CaseTree;
}

export interface CaseTree {
  tree_id: string;
  symptom: string;
  title: string;
  version: number;
  markdown: string;
  evidence_gatherer_metadata: string[];
  /** How the tree was attributed to this case: written for it, or matched after the fact. */
  attribution: 'reinforcement' | 'offline_extract';
}

/** A tree compiled to an executable graph, with the gold path the exploration run took. */
export interface CompiledTree {
  tree_id: string;
  view: DecisionTreeView;
  /** Node ids in walk order along the edges marked as taken. */
  goldPath: string[];
}

/** One evidence-gatherer node's bound observation, as handed to the branch chooser. */
export interface BoundEvidence {
  node_id: string;
  label: string;
  description?: string;
  observations: Array<{ tool_id: string; command: string; result: string }>;
}

export interface EdgeOption {
  key: string;
  target_node_id: string;
  condition: string;
}

export interface BranchDecision {
  chosen?: string;
  probabilities: Record<string, number>;
  none_probability: number;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
}

/** Picks an outgoing edge at a branching node from the alert and evidence gathered so far. */
export type BranchChooser = (request: {
  question: string;
  decisionLabel: string;
  evidence: BoundEvidence[];
  options: EdgeOption[];
}) => Promise<BranchDecision>;

export type NoneRule = 'every_hop' | 'entry_only';

export type EscalationReason = 'low_confidence' | 'off_tree' | 'symptom_mismatch' | 'dead_end';

export interface Hop {
  node_id: string;
  options: EdgeOption[];
  decision: BranchDecision;
  taken?: string;
}

export interface WalkResult {
  outcome: 'resolved' | 'escalated';
  terminal_node_id?: string;
  terminal_label?: string;
  escalation_reason?: EscalationReason;
  path: string[];
  hops: Hop[];
  evidence_missing: number;
  chooser_latency_ms: number;
}
