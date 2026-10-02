/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Agent, fetch } from 'undici';
import { GoalPassJudgePrompt } from '../../evals/investigation/judges/prompts';
import { goalScorePassed, normalizeGoalScore } from '../../evals/investigation/judges/scoring';
import type { BranchChooser } from './types';

const NONE_KEY = 'none_of_these';

export interface KibanaTarget {
  url: string;
  username: string;
  password: string;
}

export const DEFAULT_SCOUT_KIBANA: KibanaTarget = {
  url: 'http://localhost:5620',
  username: 'elastic',
  password: 'changeme',
};

// Synchronous agent rounds hold the response for minutes; match Agent Builder's 15 minute socket.
const LONG_REQUEST_MS = 15 * 60_000;
const dispatcher = new Agent({ headersTimeout: LONG_REQUEST_MS, bodyTimeout: LONG_REQUEST_MS });

export const kibanaFetch = async <T>(
  target: KibanaTarget,
  path: string,
  init: { method?: string; body?: unknown; apiVersion?: string } = {}
): Promise<T> => {
  const res = await fetch(`${target.url}${path}`, {
    dispatcher,
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`).toString(
        'base64'
      )}`,
      'Content-Type': 'application/json',
      'kbn-xsrf': 'true',
      'x-elastic-internal-origin': 'kibana',
      ...(init.apiVersion ? { 'elastic-api-version': init.apiVersion } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

interface ToolCallResponse {
  content?: string;
  toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tokens?: { prompt?: number; completion?: number };
}

/**
 * Same branching question as the Jev chooser, asked of a generative model through Kibana's
 * inference API, so "tree as code" and "Jev specifically" can be measured separately.
 */
export const createLlmChooser =
  (target: KibanaTarget, connectorId: string): BranchChooser =>
  async ({ question, decisionLabel, evidence, options }) => {
    const keys = [...options.map(({ key }) => key), NONE_KEY];
    const started = performance.now();
    const response = await kibanaFetch<ToolCallResponse>(
      target,
      '/internal/inference/chat_complete',
      {
        method: 'POST',
        body: {
          connectorId,
          temperature: 0,
          system:
            'You route an incident through a known decision tree. For each candidate condition, give the probability (0-1) that it holds for this incident given the evidence. Also give the probability that none of them hold or the evidence is about a different problem. Judge each independently; they need not sum to 1.',
          messages: [
            {
              role: 'user',
              content: JSON.stringify({
                alert: question,
                decision: decisionLabel,
                evidence,
                candidate_conditions: Object.fromEntries(
                  options.map(({ key, condition }) => [key, condition])
                ),
              }),
            },
          ],
          tools: {
            choose: {
              description:
                'Report a probability for each candidate condition and for none_of_these.',
              schema: {
                type: 'object',
                properties: Object.fromEntries(keys.map((key) => [key, { type: 'number' }])),
                required: keys,
              },
            },
          },
          toolChoice: { function: 'choose' },
        },
      }
    );
    const latencyMs = performance.now() - started;
    const args = response.toolCalls?.[0]?.function.arguments ?? {};
    const probabilities = Object.fromEntries(
      options.map(({ key }) => [key, Number(args[key] ?? 0)])
    );
    const [best] = Object.entries(probabilities).sort(([, a], [, b]) => b - a);
    return {
      chosen: best?.[0],
      probabilities,
      none_probability: Number(args[NONE_KEY] ?? 0),
      latency_ms: latencyMs,
      input_tokens: response.tokens?.prompt,
      output_tokens: response.tokens?.completion,
    };
  };

export interface GoalVerdict {
  raw_score: number;
  score: number;
  passed: boolean;
  summary: string;
}

/** Runs the suite's own goal_pass judge prompt, unchanged, against an arbitrary answer text. */
export const judgeGoalPass = async (
  target: KibanaTarget,
  connectorId: string,
  input: { question: string; reference: string; answer: string }
): Promise<GoalVerdict> => {
  const { name, description, versions } = GoalPassJudgePrompt;
  const response = await kibanaFetch<ToolCallResponse>(target, '/internal/inference/prompt', {
    method: 'POST',
    body: {
      connectorId,
      prompt: { name, description, versions },
      input,
      toolChoice: { function: 'score' },
    },
  });
  const args = response.toolCalls?.[0]?.function.arguments as
    | { score: number; summary: string }
    | undefined;
  if (!args) throw new Error('goal_pass judge returned no tool call');
  return {
    raw_score: args.score,
    score: normalizeGoalScore(args.score),
    passed: goalScorePassed(args.score),
    summary: args.summary,
  };
};
