/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { kibanaFetch, type KibanaTarget } from './kibana_client';
import type { EvidenceGatherer } from './run_tree';

export const EVIDENCE_AGENT_ID = 'nightshift-jev-evidence-gatherer';
const AGENT_API_VERSION = '2023-10-31';
const MAX_FINDINGS_CHARS = 4_000;

const SANDBOX_TOOL_IDS = [
  'nightshift_sandbox_bash',
  'nightshift_sandbox_view_file',
  'nightshift_sandbox_write_file',
  'nightshift_sandbox_str_replace',
] as const;

const INSTRUCTIONS = `You gather evidence for one step of a known incident-investigation procedure.
Another system decides what the evidence means, so collect facts and do not diagnose.

Before your first query in a conversation, read /workspace/elastic.md with nightshift_sandbox_view_file:
it explains how to reach the telemetry cluster. Pass the telemetry connector_id on every command that
queries Elasticsearch, and prefer ES|QL STATS or _count over raw documents.

Time window: anchor every query on the detection time in the incident description, from one hour
before to one hour after it. Widen only when the step explicitly asks for a baseline or history, and
then aggregate with coarse BUCKET intervals. Use --max-time 60. If a query times out, narrow the
window or the index pattern; never rerun the same query.

Each message names the step and what it looks at. Run only the queries that step needs. Stop after
six commands even if the picture is incomplete, and report what you have. If the data the step asks
about does not exist or cannot be found, say so plainly: an empty result is evidence too.

Reply with only a short "Findings:" list of at most eight bullets. Each bullet states one observed
fact with its numbers, timestamps, and the index or query it came from. No recommendations, no
root-cause claims.`;

interface ConverseResponse {
  conversation_id: string;
  status?: string;
  response?: { message?: string };
  steps?: Array<{ type: string; tool_id?: string }>;
  model_usage?: { input_tokens?: number; output_tokens?: number; llm_calls?: number };
}

/** Creates (or replaces) the evidence agent: sandbox tools plus the telemetry connector, no skills. */
export const ensureEvidenceAgent = async (
  target: KibanaTarget,
  telemetryConnectorId: string
): Promise<void> => {
  const path = `/api/agent_builder/agents/${EVIDENCE_AGENT_ID}`;
  await kibanaFetch(target, path, { method: 'DELETE', apiVersion: AGENT_API_VERSION }).catch(
    () => undefined
  );
  await kibanaFetch(target, '/api/agent_builder/agents', {
    method: 'POST',
    apiVersion: AGENT_API_VERSION,
    body: {
      id: EVIDENCE_AGENT_ID,
      name: 'Nightshift evidence gatherer (Jev prototype)',
      description: 'Runs the queries for one decision-tree evidence step and reports findings.',
      configuration: {
        instructions: INSTRUCTIONS,
        tools: [{ tool_ids: [...SANDBOX_TOOL_IDS] }],
        connector_ids: [telemetryConnectorId],
      },
    },
  });
};

export interface EvidenceStepRecord {
  node_id: string;
  label: string;
  duration_ms: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  findings: string;
  error?: string;
}

/**
 * Returns a gatherer that runs each evidence step as one round of a single conversation, so the
 * sandbox and earlier findings carry over between steps of the same walk.
 */
export const createLiveGatherer = ({
  target,
  connectorId,
  question,
}: {
  target: KibanaTarget;
  connectorId: string;
  question: string;
}): {
  gather: EvidenceGatherer;
  steps: EvidenceStepRecord[];
  conversationId: () => string | undefined;
} => {
  const steps: EvidenceStepRecord[] = [];
  let conversationId: string | undefined;

  const gather: EvidenceGatherer = async (node) => {
    const description = node.node_metadata?.description;
    const input = [
      ...(conversationId ? [] : [`Incident under investigation:\n${question}`, '']),
      `Evidence step ${node.node_id}: ${node.label}`,
      ...(description ? [`What it looks at: ${description}`] : []),
    ].join('\n');
    const started = performance.now();
    const record: EvidenceStepRecord = {
      node_id: node.node_id,
      label: node.label,
      duration_ms: 0,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      findings: '',
    };
    try {
      const response = await kibanaFetch<ConverseResponse>(target, '/api/agent_builder/converse', {
        method: 'POST',
        apiVersion: AGENT_API_VERSION,
        body: {
          agent_id: EVIDENCE_AGENT_ID,
          connector_id: connectorId,
          input,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        },
      });
      conversationId = response.conversation_id;
      record.findings = (response.response?.message ?? '').slice(0, MAX_FINDINGS_CHARS);
      record.tool_calls = (response.steps ?? []).filter(({ type }) => type === 'tool_call').length;
      record.input_tokens = response.model_usage?.input_tokens ?? 0;
      record.output_tokens = response.model_usage?.output_tokens ?? 0;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    record.duration_ms = performance.now() - started;
    steps.push(record);
    return {
      node_id: node.node_id,
      label: node.label,
      description,
      observations: record.findings
        ? [{ tool_id: EVIDENCE_AGENT_ID, command: node.label, result: record.findings }]
        : [],
    };
  };

  return { gather, steps, conversationId: () => conversationId };
};
