/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InferenceInferenceEndpointInfo } from '@elastic/elasticsearch/lib/api/types';
import { findTranscriptionEndpoint, toTranscript } from './voice';

const endpoint = (inferenceId: string, modelId: string, service = 'elastic') =>
  ({
    inference_id: inferenceId,
    service,
    service_settings: { model_id: modelId },
    task_type: 'chat_completion',
  } as InferenceInferenceEndpointInfo);

describe('findTranscriptionEndpoint', () => {
  it('prefers the fastest Elastic Inference Service model that understands speech', () => {
    expect(
      findTranscriptionEndpoint([
        endpoint('.claude', 'anthropic-claude-5-sonnet'),
        endpoint('.gemini-3.8', 'google-gemini-3.8-flash'),
        endpoint('.gemini-3.5-lite', 'google-gemini-3.5-flash-lite'),
      ])
    ).toBe('.gemini-3.5-lite');
  });

  it('ignores endpoints outside the Elastic Inference Service', () => {
    expect(
      findTranscriptionEndpoint([
        endpoint('my-gemini', 'google-gemini-3.6-flash', 'googlevertexai'),
      ])
    ).toBeUndefined();
  });
});

describe('toTranscript', () => {
  it('returns what was said', () => {
    expect(toTranscript({ choices: [{ message: { content: ' Which services fail? \n' } }] })).toBe(
      'Which services fail?'
    );
  });

  it('treats a recording without speech as empty', () => {
    expect(toTranscript({ choices: [{ message: { content: '[no speech]' } }] })).toBe('');
  });
});
