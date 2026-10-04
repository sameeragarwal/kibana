/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pMap from 'p-map';
import { kibanaFetch, type KibanaTarget } from './kibana_client';
import type { EvidenceGatherer } from './run_tree';
import { runEsql, type EsqlResult, type TelemetryTarget } from './telemetry_client';
import type { BoundEvidence, CaseFixture, CompiledTree } from './types';

const MAX_REFERENCE_QUERIES = 40;
const MAX_ROWS = 30;
const MAX_CELL_CHARS = 160;
const MAX_RESULT_CHARS = 3_000;
const PLACEHOLDERS = ['remote', 'detected', 'started'] as const;
const LITERAL_DATE = /\d{4}-\d{2}-\d{2}/;

/** Values filled into query templates, parsed from the alert text without a model. */
export type IncidentParams = Record<(typeof PLACEHOLDERS)[number], string>;

export interface QueryTemplate {
  purpose: string;
  esql: string;
}

export interface NodeQueries {
  node_id: string;
  queries: QueryTemplate[];
}

export interface QueryValidation {
  node_id: string;
  purpose: string;
  status: 'rows' | 'empty' | 'error';
  rows: number;
  error?: string;
}

/** Output of the offline compile: per evidence node, the ES|QL to run at walk time. */
export interface CompiledQueries {
  case_id: string;
  tree_id: string;
  steps: NodeQueries[];
  validation: QueryValidation[];
  compile: { llm_calls: number; input_tokens: number; output_tokens: number; duration_ms: number };
}

const ISO_MINUTE = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*UTC/;

/** Pulls detection time, start time, and the telemetry remote out of a C0 alert description. */
export const extractIncidentParams = (question: string): IncidentParams => {
  const detectedMatch = question.match(new RegExp(`Detected[^:]*:\\s*${ISO_MINUTE.source}`));
  const startedMatch = question.match(
    new RegExp(`(?:started|present since)\\s+(\\d{4}-\\d{2}-\\d{2})(?:[ T](\\d{2}:\\d{2}))?`, 'i')
  );
  const detected = detectedMatch
    ? `${detectedMatch[1]}T${detectedMatch[2]}:00Z`
    : new Date().toISOString();
  const started = startedMatch ? `${startedMatch[1]}T${startedMatch[2] ?? '00:00'}:00Z` : detected;
  const region = question.match(/\b(azure|gcp|aws)[.\- ]([a-z]+(?:-[a-z0-9]+)*\d?)\b/i);
  const remote = region
    ? `logging-${region[1].toLowerCase()}-${region[2].toLowerCase()}`
    : 'logging-*';
  return { remote, detected, started };
};

export const fillTemplate = (esql: string, params: IncidentParams): string =>
  PLACEHOLDERS.reduce((query, key) => query.split(`{{${key}}}`).join(params[key]), esql);

const QUERY_IN_COMMAND = /"query"\s*:\s*("(?:[^"\\]|\\.)*")/g;
const QUERY_IN_TRIPLE_QUOTES = /"""\s*(FROM[\s\S]*?)"""/g;

/** ES|QL the exploration run sent, each with the head of what came back. */
const referenceQueries = (fixture: CaseFixture) =>
  fixture.trajectory
    .filter(({ tool_id: toolId }) => toolId === 'nightshift_sandbox_bash')
    .flatMap(({ params, result }) => {
      const command = String(params.command ?? '');
      const text = String(result ?? '');
      const failed = /"error"|verification_exception|parsing_exception|timed out/i.test(
        text.slice(0, 800)
      );
      const fromJson = [...command.matchAll(QUERY_IN_COMMAND)].flatMap(([, literal]) => {
        try {
          return [JSON.parse(literal) as string];
        } catch {
          return [];
        }
      });
      const fromPython = [...command.matchAll(QUERY_IN_TRIPLE_QUOTES)].map(([, esql]) => esql);
      return [...fromJson, ...fromPython].map((esql) => ({
        esql,
        failed,
        result_head: text.slice(0, failed ? 300 : 500),
      }));
    })
    .slice(-MAX_REFERENCE_QUERIES);

const COMPILER_SYSTEM = `You compile the evidence steps of an incident decision tree into ES|QL query templates.
The templates run later with no model in the loop: their raw results go straight to a classifier
that picks the next branch, so each step's queries must return the numbers that decide the branches
directly after it in the tree. Rules:
- 1 to 3 queries per evidence step, each with a one-line purpose.
- Aggregate (STATS ... BY, BUCKET) and keep results under 50 rows; never return raw documents
  except a LIMIT 5 sample when the step asks for messages.
- Use only these placeholders: {{remote}} (a remote cluster prefix such as logging-azure-eastus or
  logging-*), {{detected}} and {{started}} (ISO timestamps). Write time bounds with ES|QL date math,
  e.g. @timestamp >= TO_DATETIME("{{detected}}") - 1 hour. Never write a literal date; the
  templates must work for a future incident of the same kind. Default to one hour either side of
  {{detected}}; use {{started}} or a wider baseline only when the step is about history.
- Reuse the index patterns, field names, and filters that returned data in the reference queries.
  Never reuse ones that errored. If a reference query used a specific remote that worked, you may
  keep it literally when {{remote}} would be wrong for this kind of incident.
- Quote dotted or special field names with backticks when the reference queries did.
- Every query must finish in under 60 seconds on a large cross-cluster deployment. Name a specific
  data stream (logs-<dataset>.log-default, or logs-<dataset>* at most) rather than logs-* or
  metrics-*, and only filter on message with LIKE when the index is already that narrow.`;

const compileTool = {
  description: 'Return the ES|QL templates for every evidence step.',
  schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            queries: {
              type: 'array',
              items: {
                type: 'object',
                properties: { purpose: { type: 'string' }, esql: { type: 'string' } },
                required: ['purpose', 'esql'],
              },
            },
          },
          required: ['node_id', 'queries'],
        },
      },
    },
    required: ['steps'],
  },
} as const;

interface ChatResponse {
  toolCalls?: Array<{ function: { arguments: { steps?: NodeQueries[] } } }>;
  tokens?: { prompt?: number; completion?: number };
}

const validate = async (
  telemetry: TelemetryTarget,
  steps: NodeQueries[],
  params: IncidentParams
): Promise<QueryValidation[]> =>
  pMap(
    steps.flatMap(({ node_id: nodeId, queries }) => queries.map((query) => ({ nodeId, query }))),
    async ({ nodeId, query }): Promise<QueryValidation> => {
      if (LITERAL_DATE.test(query.esql)) {
        return {
          node_id: nodeId,
          purpose: query.purpose,
          status: 'error',
          rows: 0,
          error: 'hard-coded date: use {{detected}} or {{started}} with date math instead',
        };
      }
      const result = await runEsql(telemetry, fillTemplate(query.esql, params));
      return {
        node_id: nodeId,
        purpose: query.purpose,
        status: !result.ok ? 'error' : result.values.length ? 'rows' : 'empty',
        rows: result.values.length,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    { concurrency: 4 }
  );

/**
 * Compiles one tree's evidence steps to ES|QL templates with a single model call, validates them
 * against the telemetry cluster, and gives the model one pass to repair the queries that errored.
 * This is the only model use in the template arm, and it happens once per tree, not per incident.
 */
export const compileQueryTemplates = async ({
  fixture,
  tree,
  target,
  connectorId,
  telemetry,
}: {
  fixture: CaseFixture;
  tree: CompiledTree;
  target: KibanaTarget;
  connectorId: string;
  telemetry: TelemetryTarget;
}): Promise<CompiledQueries> => {
  const started = performance.now();
  const params = extractIncidentParams(fixture.question);
  const nodes = tree.view.nodes
    .filter(({ node_type: type }) => type === 'evidence_gatherer')
    .map(({ node_id: id, label, node_metadata: meta }) => ({
      node_id: id,
      label,
      looks_at: meta?.description,
    }));
  const usage = { llm_calls: 0, input_tokens: 0, output_tokens: 0 };

  const ask = async (content: unknown): Promise<NodeQueries[]> => {
    const response = await kibanaFetch<ChatResponse>(target, '/internal/inference/chat_complete', {
      method: 'POST',
      body: {
        connectorId,
        temperature: 0,
        system: COMPILER_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(content) }],
        tools: { emit_queries: compileTool },
        toolChoice: { function: 'emit_queries' },
      },
    });
    usage.llm_calls += 1;
    usage.input_tokens += response.tokens?.prompt ?? 0;
    usage.output_tokens += response.tokens?.completion ?? 0;
    return response.toolCalls?.[0]?.function.arguments.steps ?? [];
  };

  let steps = await ask({
    alert: fixture.question,
    placeholder_values_for_this_alert: params,
    tree: fixture.tree?.markdown,
    evidence_steps: nodes,
    evidence_step_notes: fixture.tree?.evidence_gatherer_metadata,
    reference_queries: referenceQueries(fixture),
  });
  let validation = await validate(telemetry, steps, params);

  const broken = validation.filter(({ status }) => status === 'error');
  if (broken.length) {
    const repaired = await ask({
      task: 'Some templates failed. Return the full set of steps again with the failing queries fixed; keep working queries unchanged. A timeout means the query scanned too much: narrow the index pattern to one data stream, drop LIKE filters on message, or shorten the window.',
      placeholder_values_for_this_alert: params,
      steps,
      failures: broken.map(({ node_id: id, purpose, error }) => ({ node_id: id, purpose, error })),
      reference_queries: referenceQueries(fixture).filter(({ failed }) => !failed),
    });
    if (repaired.length) {
      steps = repaired;
      validation = await validate(telemetry, steps, params);
    }
  }

  return {
    case_id: fixture.case_id,
    tree_id: tree.tree_id,
    steps,
    validation,
    compile: { ...usage, duration_ms: performance.now() - started },
  };
};

const formatResult = ({ ok, columns, values, error }: EsqlResult): string => {
  if (!ok) return `query failed: ${error}`;
  if (!values.length) return '0 rows (no matching data)';
  const cell = (value: unknown) =>
    (typeof value === 'string' ? value : JSON.stringify(value) ?? 'null').slice(0, MAX_CELL_CHARS);
  const lines = [
    columns.join(' | '),
    ...values.slice(0, MAX_ROWS).map((row) => row.map(cell).join(' | ')),
  ];
  if (values.length > MAX_ROWS) lines.push(`... ${values.length - MAX_ROWS} more rows`);
  return lines.join('\n').slice(0, MAX_RESULT_CHARS);
};

export interface TemplateStepRecord {
  node_id: string;
  label: string;
  duration_ms: number;
  queries: Array<{ purpose: string; status: 'rows' | 'empty' | 'error'; rows: number; ms: number }>;
  /** Set when the step had no usable query and the Sonnet evidence agent ran instead. */
  fell_back_to_agent?: boolean;
}

/**
 * Returns a gatherer that runs a node's compiled ES|QL directly and hands the raw tables to the
 * chooser. When every query for a node errors (or none exist), it defers to `fallback`.
 */
export const createTemplateGatherer = ({
  compiled,
  params,
  telemetry,
  fallback,
}: {
  compiled: CompiledQueries;
  params: IncidentParams;
  telemetry: TelemetryTarget;
  fallback?: EvidenceGatherer;
}): { gather: EvidenceGatherer; steps: TemplateStepRecord[] } => {
  const steps: TemplateStepRecord[] = [];
  const byNode = new Map(compiled.steps.map((step) => [step.node_id, step.queries]));

  const gather: EvidenceGatherer = async (node) => {
    const started = performance.now();
    const queries = byNode.get(node.node_id) ?? [];
    const results = await Promise.all(
      queries.map(async (query) => ({
        query,
        filled: fillTemplate(query.esql, params),
        result: await runEsql(telemetry, fillTemplate(query.esql, params)),
      }))
    );
    const record: TemplateStepRecord = {
      node_id: node.node_id,
      label: node.label,
      duration_ms: 0,
      queries: results.map(({ query, result }) => ({
        purpose: query.purpose,
        status: !result.ok ? 'error' : result.values.length ? 'rows' : 'empty',
        rows: result.values.length,
        ms: Math.round(result.took_ms),
      })),
    };
    let evidence: BoundEvidence = {
      node_id: node.node_id,
      label: node.label,
      description: node.node_metadata?.description,
      observations: results.map(({ query, filled, result }) => ({
        tool_id: 'esql',
        command: `${query.purpose}\n${filled}`,
        result: formatResult(result),
      })),
    };
    if (fallback && !results.some(({ result }) => result.ok)) {
      record.fell_back_to_agent = true;
      evidence = await fallback(node);
    }
    record.duration_ms = performance.now() - started;
    steps.push(record);
    return evidence;
  };

  return { gather, steps };
};
