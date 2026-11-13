/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AgentPromptType } from '@kbn/agent-builder-common/agents';
import { toPromptSpeechText, toSpeechText, toStepSpeechText } from './to_speech_text';

describe('toPromptSpeechText', () => {
  it('reads the question and its options before asking for an answer on screen', () => {
    expect(
      toPromptSpeechText([
        {
          type: AgentPromptType.ask_user_question,
          id: 'q',
          questions: [
            {
              question: 'What did you **mean**?',
              multi_select: false,
              options: [{ label: 'Alerting' }, { label: 'Erroring', description: 'Errors' }],
            },
          ],
        },
      ])
    ).toBe('What did you mean? The options are: Alerting, Erroring. Answer on screen to continue.');
  });

  it('reads what a confirmation is about', () => {
    expect(
      toPromptSpeechText([
        { type: AgentPromptType.confirmation, id: 'c', title: 'Restart checkout', message: '' },
      ])
    ).toBe('Restart checkout. Answer on screen to continue.');
  });
});

describe('toSpeechText', () => {
  it('reads prose without markdown syntax', () => {
    expect(
      toSpeechText('## Summary\n\n**checkout_service** is failing. See [the trace](http://x).')
    ).toBe('Summary. checkout service is failing. See the trace.');
  });

  it('reads list items as sentences', () => {
    expect(toSpeechText('Two issues:\n- High latency\n* Errors on `payment`')).toBe(
      'Two issues: High latency. Errors on payment.'
    );
  });

  it('leaves code and tables on screen and says so', () => {
    expect(
      toSpeechText('Run this:\n```esql\nFROM logs\n```\n| a | b |\n|---|---|\n| 1 | 2 |')
    ).toBe('Run this: The details are on screen.');
  });

  it('points to the screen when nothing can be read aloud', () => {
    expect(toSpeechText('```json\n{}\n```')).toBe('The answer is on screen.');
  });

  it('cuts a long reply at a sentence boundary', () => {
    const spoken = toSpeechText('This sentence is long enough to repeat. '.repeat(40));

    expect(spoken.length).toBeLessThan(860);
    expect(spoken).toMatch(/repeat\. The details are on screen\.$/);
  });
});

describe('toStepSpeechText', () => {
  it('reads a tool intent as a sentence', () => {
    expect(toStepSpeechText('Count docs in logs-*/traces-*, last 15m')).toBe(
      'Count docs in logs and traces, last 15 minutes.'
    );
  });
});
