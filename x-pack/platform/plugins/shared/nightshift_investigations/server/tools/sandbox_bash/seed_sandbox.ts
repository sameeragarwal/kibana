/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { SandboxApiClient } from './grpc_client';
import type { ConnectorSource } from './connector_sources';
import { renderConnectorFiles, renderElasticMd, renderTelemetryFiles } from './connector_env';

export const seedSandbox = async ({
  conversationId,
  apiClient,
  request,
  getConnectors,
  telemetryEs,
  logger,
}: {
  conversationId: string;
  apiClient: SandboxApiClient;
  request: KibanaRequest;
  getConnectors: ConnectorSource;
  telemetryEs?: { url: string; apiKey: string };
  logger: Logger;
}): Promise<void> => {
  const connectors = await getConnectors(request);
  const telemetry = telemetryEs !== undefined ? renderTelemetryFiles(telemetryEs) : undefined;

  if (connectors.length === 0 && telemetry === undefined) {
    logger.debug('No connectors or telemetry creds available; skipping sandbox seeding');
    return;
  }

  const rendered = renderConnectorFiles(connectors);
  const env = [telemetry?.env, rendered.env].filter((part) => part && part.length > 0).join('\n');
  const markdown = [rendered.markdown, telemetry?.markdown]
    .filter((part) => part && part.length > 0)
    .join('\n');

  const files = [
    { path: '/workspace/.env', content: Buffer.from(env, 'utf8') },
    { path: '/workspace/connectors.md', content: Buffer.from(markdown, 'utf8') },
    ...(telemetry !== undefined
      ? [{ path: '/workspace/elastic.md', content: Buffer.from(renderElasticMd(), 'utf8') }]
      : []),
  ];

  await apiClient.writeFiles(conversationId, files);

  logger.info(
    `Sandbox seeded with ${connectors.length} connector(s)${
      telemetry !== undefined ? ' and local ES telemetry creds' : ''
    }`
  );
};
