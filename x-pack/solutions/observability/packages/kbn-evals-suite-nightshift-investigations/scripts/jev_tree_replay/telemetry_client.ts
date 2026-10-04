/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';

export const DEFAULT_TELEMETRY_CONFIG = join(
  REPO_ROOT,
  'x-pack/platform/packages/shared/kbn-evals/scripts/vault/config.sandbox-ocp.json'
);
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

/** The remote telemetry cluster the sandbox's connector points at. */
export interface TelemetryTarget {
  url: string;
  apiKey: string;
  timeoutMs: number;
}

/** Reads `.nightshift.telemetry` from an evals config; the key stays in memory and is never logged. */
export const readTelemetryTarget = (
  configPath: string,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS
): TelemetryTarget => {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    nightshift?: { telemetry?: { url?: string; apiKey?: string } };
  };
  const { url, apiKey } = config.nightshift?.telemetry ?? {};
  if (!url || !apiKey) throw new Error(`${configPath} has no nightshift.telemetry url and apiKey`);
  return { url, apiKey, timeoutMs };
};

export interface EsqlResult {
  ok: boolean;
  columns: string[];
  values: unknown[][];
  error?: string;
  took_ms: number;
}

/** Runs one ES|QL query directly against the telemetry cluster, no agent or model involved. */
export const runEsql = async (target: TelemetryTarget, query: string): Promise<EsqlResult> => {
  const started = performance.now();
  try {
    const res = await fetch(new URL('/_query', target.url), {
      method: 'POST',
      headers: { Authorization: `ApiKey ${target.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    const body = (await res.json()) as {
      columns?: Array<{ name: string }>;
      values?: unknown[][];
      error?: { type?: string; reason?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        columns: [],
        values: [],
        error: `${res.status} ${body.error?.type ?? ''}: ${body.error?.reason ?? ''}`.slice(0, 400),
        took_ms: performance.now() - started,
      };
    }
    return {
      ok: true,
      columns: (body.columns ?? []).map(({ name }) => name),
      values: body.values ?? [],
      took_ms: performance.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      columns: [],
      values: [],
      error: error instanceof Error ? error.message : String(error),
      took_ms: performance.now() - started,
    };
  }
};
