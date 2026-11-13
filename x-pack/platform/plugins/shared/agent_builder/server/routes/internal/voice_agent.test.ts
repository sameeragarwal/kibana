/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { buildVoiceAgentMessages, parseVoiceAgentReply } from './voice_agent';

describe('buildVoiceAgentMessages', () => {
  it('tells the voice what the assistant is doing and how the call went', () => {
    const [system, { content }] = buildVoiceAgentMessages({
      trigger: 'progress',
      transcript: [
        { speaker: 'user', text: 'Which services are failing?' },
        { speaker: 'voice', text: "I'm on it." },
      ],
      agent: {
        status: 'working',
        task: 'Find services with errors in the last 15 minutes',
        activity: ['Count failed transactions per service.'],
      },
    });

    expect(system.role).toBe('system');
    expect(content).toContain('working on: "Find services with errors in the last 15 minutes"');
    expect(content).toContain('- Count failed transactions per service.');
    expect(content).toContain("User: Which services are failing?\nYou: I'm on it.");
  });

  it('hands the voice the written answer to talk through', () => {
    const [, { content }] = buildVoiceAgentMessages({
      trigger: 'answer',
      transcript: [],
      agent: { status: 'idle' },
      answer: 'Checkout has **42** errors.',
    });

    expect(content).toContain('The assistant is idle.');
    expect(content).toContain('Checkout has **42** errors.');
  });
});

describe('parseVoiceAgentReply', () => {
  it('reads what to say and the request for the assistant', () => {
    expect(
      parseVoiceAgentReply({
        content: 'Sure, checking now.',
        tool_calls: [
          {
            function: {
              name: 'ask_nightshift_assistant',
              arguments: '{"request": "List services with errors in the last 15 minutes"}',
            },
          },
        ],
      })
    ).toEqual({
      say: 'Sure, checking now.',
      askAgent: 'List services with errors in the last 15 minutes',
    });
  });

  it('just talks when the assistant is not needed', () => {
    expect(parseVoiceAgentReply({ content: ' Doing well, thanks! ' })).toEqual({
      say: 'Doing well, thanks!',
    });
  });

  it('ignores malformed tool calls', () => {
    expect(
      parseVoiceAgentReply({
        content: null,
        tool_calls: [{ function: { name: 'ask_nightshift_assistant', arguments: 'not json' } }],
      })
    ).toEqual({ say: '' });
    expect(parseVoiceAgentReply(undefined)).toEqual({ say: '' });
  });
});
