/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DecisionNodeView } from '@kbn/nightshift-decision-trees';
import type { TrajectoryStep } from '../../evals/investigation/types';
import type { BoundEvidence } from './types';

const MAX_OBSERVATIONS_PER_NODE = 2;
const MAX_RESULT_CHARS = 2_500;
const MIN_SHARED_TOKENS = 2;

const STOPWORDS = new Set([
  'query',
  'check',
  'from',
  'where',
  'with',
  'that',
  'this',
  'over',
  'into',
  'stats',
  'limit',
  'sort',
  'true',
  'false',
  'null',
  'curl',
  'json',
  'http',
  'https',
  'size',
  'echo',
  'python',
  'print',
  'import',
]);

const tokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.*-]+/)
      .flatMap((token) => token.split(/[.]/).concat(token))
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token))
  );

const commandOf = ({ params }: TrajectoryStep): string => {
  const { command, query, esql } = params as Record<string, unknown>;
  const primary = [command, query, esql].find((value) => typeof value === 'string');
  return typeof primary === 'string' ? primary : JSON.stringify(params);
};

/** Tool calls that are bookkeeping rather than evidence: reading playbooks, reporting progress. */
const isEvidenceCall = (step: TrajectoryStep): boolean => {
  const serialized = JSON.stringify(step.params);
  return !serialized.includes('decision-trees/') && !/progress_report/.test(step.tool_id);
};

/**
 * Binds an evidence node to the recorded tool calls whose commands share the most distinctive
 * tokens (indices, fields, services) with the node's label and stored query metadata. Replaying
 * those results stands in for re-running the node's queries against the incident's time window.
 */
export const bindEvidence = (
  node: DecisionNodeView,
  trajectory: TrajectoryStep[]
): BoundEvidence => {
  const nodeTokens = tokens(`${node.label} ${node.node_metadata?.description ?? ''}`);
  const ranked = trajectory
    .filter(isEvidenceCall)
    .map((step) => {
      const shared = [...tokens(commandOf(step))].filter((token) => nodeTokens.has(token));
      return { step, score: shared.length };
    })
    .filter(({ score }) => score >= MIN_SHARED_TOKENS)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OBSERVATIONS_PER_NODE);
  return {
    node_id: node.node_id,
    label: node.label,
    description: node.node_metadata?.description,
    observations: ranked.map(({ step }) => ({
      tool_id: step.tool_id,
      command: commandOf(step).slice(0, 600),
      result: step.result.slice(0, MAX_RESULT_CHARS),
    })),
  };
};
