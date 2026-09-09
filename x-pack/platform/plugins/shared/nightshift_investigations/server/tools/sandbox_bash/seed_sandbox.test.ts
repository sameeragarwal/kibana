/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { seedSandbox } from './seed_sandbox';
import { renderElasticMd } from './connector_env';

const request = {} as never;

const makeLogger = () =>
  ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }) as never;

describe('seedSandbox', () => {
  it('writes elastic.md when telemetry creds are present', async () => {
    const writeFiles = jest.fn().mockResolvedValue(undefined);
    await seedSandbox({
      conversationId: 'conv-1',
      apiClient: { writeFiles } as never,
      request,
      getConnectors: async () => [],
      telemetryEs: { url: 'http://host.docker.internal:9200', apiKey: 'encoded-key' },
      logger: makeLogger(),
    });

    const files = writeFiles.mock.calls[0][1] as Array<{ path: string; content: Buffer }>;
    const paths = files.map((file) => file.path);
    expect(paths).toContain('/workspace/.env');
    expect(paths).toContain('/workspace/elastic.md');
    const elastic = files.find((file) => file.path === '/workspace/elastic.md');
    expect(elastic?.content.toString('utf8')).toBe(renderElasticMd());
    expect(elastic?.content.toString('utf8')).toContain('ELASTICSEARCH_URL');
    expect(elastic?.content.toString('utf8')).not.toContain('encoded-key');
  });

  it('does not write elastic.md when telemetry creds are absent', async () => {
    const writeFiles = jest.fn().mockResolvedValue(undefined);
    await seedSandbox({
      conversationId: 'conv-1',
      apiClient: { writeFiles } as never,
      request,
      getConnectors: async () => [
        {
          id: 'c1',
          name: 'GitHub',
          actionTypeId: '.github',
          config: {},
          secrets: { token: 't' },
        },
      ],
      logger: makeLogger(),
    });

    const files = writeFiles.mock.calls[0][1] as Array<{ path: string }>;
    expect(files.map((file) => file.path)).not.toContain('/workspace/elastic.md');
  });
});
