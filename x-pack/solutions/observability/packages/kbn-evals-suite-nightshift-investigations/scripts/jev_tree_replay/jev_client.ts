/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { setTimeout } from 'timers/promises';
import type { BranchChooser } from './types';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const RETRYABLE = new Set([429, 529, 500, 502, 503]);
const NONE_KEY = 'none_of_these';

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> };

/** Reads the key from the environment, else from a private file; never logged. */
export const readJevApiKey = (): string => {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.typesafe_api_key'), 'utf8').trim();
  } catch {
    throw new Error('Set TYPESAFE_API_KEY or write the key to ~/.typesafe_api_key');
  }
};

export const callSystemOne = async (
  apiKey: string,
  state: unknown,
  questions: Record<string, JevQuestion>
): Promise<{ response: SystemOneResponse; latencyMs: number }> => {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    });
    const latencyMs = performance.now() - started;
    if (res.ok) return { response: (await res.json()) as SystemOneResponse, latencyMs };
    if (!RETRYABLE.has(res.status) || attempt >= 4) {
      throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    await setTimeout(250 * 2 ** attempt);
  }
};

/**
 * Asks Jev one Noul per outgoing edge ("does this condition hold?") plus one asking whether none
 * of them do, all in a single parallel request. Nouls are independent, so the probabilities are
 * not normalized; the runner compares them directly.
 */
export const createJevChooser =
  (apiKey: string): BranchChooser =>
  async (request) => {
    const { question, decisionLabel, evidence, options } = request;
    const state = {
      alert: question,
      evidence: evidence.map(({ label, description, observations }) => ({
        step: label,
        ...(description ? { looks_at: description } : {}),
        observations: observations.map(({ command, result }) => ({ command, result })),
      })),
    };
    const questions: Record<string, JevQuestion> = Object.fromEntries(
      options.map(({ key, condition }) => [
        key,
        {
          type: 'noul',
          instructions: {
            decision: decisionLabel,
            condition,
            question:
              'Given `alert` and the observations in `evidence`, does `condition` hold as the answer to `decision`?',
          },
          criteria: {
            true: 'The evidence supports this condition for this incident.',
            false: 'The evidence contradicts this condition, or does not bear on it.',
          },
        },
      ])
    );
    questions[NONE_KEY] = {
      type: 'noul',
      instructions: {
        decision: decisionLabel,
        candidate_conditions: options.map(({ condition }) => condition),
        question:
          'Given `alert` and `evidence`, is it true that none of `candidate_conditions` describes this incident, or that the evidence is about a different problem altogether?',
      },
    };
    const { response, latencyMs } = await callSystemOne(apiKey, state, questions);
    const probabilities = Object.fromEntries(
      options.map(({ key }) => [key, response.answers[key]?.noul ?? 0])
    );
    const [best] = Object.entries(probabilities).sort(([, a], [, b]) => b - a);
    return {
      chosen: best?.[0],
      probabilities,
      none_probability: response.answers[NONE_KEY]?.noul ?? 0,
      latency_ms: latencyMs,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
    };
  };
