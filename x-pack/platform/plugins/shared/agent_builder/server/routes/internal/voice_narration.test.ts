/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { buildNarrationMessages, toNarrationText } from './voice_narration';

describe('buildNarrationMessages', () => {
  it('gives the voice the recent activity and what it already said', () => {
    const [system, { content }] = buildNarrationMessages({
      kind: 'progress',
      question: 'Which services are failing?',
      activity: ['Count failed transactions per service.'],
      said: ['Sure, let me check.'],
    });

    expect(system.role).toBe('system');
    expect(content).toContain('"Which services are failing?"');
    expect(content).toContain('- Count failed transactions per service.');
    expect(content).toContain('- Sure, let me check.');
  });

  it('asks the voice to retell the written answer', () => {
    const [, { content }] = buildNarrationMessages({
      kind: 'answer',
      question: 'Which services are failing?',
      answer: 'Checkout has **42** errors.',
    });

    expect(content).toContain('Checkout has **42** errors.');
  });
});

describe('toNarrationText', () => {
  it('drops quotes and treats the skip marker as nothing to say', () => {
    expect(toNarrationText(' "Checking now." ')).toBe('Checking now.');
    expect(toNarrationText('[skip]')).toBe('');
    expect(toNarrationText(null)).toBe('');
  });
});
