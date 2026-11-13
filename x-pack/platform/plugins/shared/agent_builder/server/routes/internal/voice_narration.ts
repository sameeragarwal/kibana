/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { NarrateRequestBody } from '../../../common/http_api/voice';

export interface NarrationMessage {
  role: 'system' | 'user';
  content: string;
}

const SKIP_MARKER = '[skip]';

const SYSTEM_PROMPT = `You are the voice of an observability assistant, talking with the user out loud on a call while a separate investigation agent does the work. The user can see the agent's written text on screen, so never read it back to them: talk about it the way a friendly, calm colleague would on a call. Use short, natural spoken sentences with no markdown, lists or symbols. Say names in plain words ("the synth log stream", not "logs-synth-default"), never spell out IDs, index patterns or field names, and round numbers the way people say them ("about nine thousand"). Only state facts that appear in what you are given; never guess numbers, names or causes.`;

const list = (items: readonly string[] = []): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '(nothing yet)';

const buildInstruction = ({
  kind,
  question,
  activity,
  said,
  answer,
}: NarrateRequestBody): string => {
  switch (kind) {
    case 'start':
      return `The user just said: "${question}"
If they asked for something to be looked into, reply with one short, natural sentence (at most 12 words) saying you're on it. Don't answer the question. If they are just chatting, greeting or thanking, reply with exactly ${SKIP_MARKER}`;
    case 'progress':
      return `The user asked: "${question}"
What the agent has been doing, oldest first:
${list(activity)}
What you already said:
${list(said)}
In one short sentence (at most 18 words), tell the user what you're doing now, in your own words, the way you would on a call. Don't read the activity back. Share an early observation only if it is stated above. Never repeat what you already said. If there is nothing new worth saying, reply with exactly ${SKIP_MARKER}`;
    case 'answer':
      return `The user asked: "${question}"
The agent's written answer, shown on their screen:
"""
${answer ?? ''}
"""
Talk the user through it in your own words, in at most three short sentences, like a colleague summing up on a call. Don't read the text, its tables or its lists back. Lead with what matters most, with at most two key numbers. If there is more detail on screen, say so briefly. If the answer is small talk or a question back to the user, just reply to them naturally. Add nothing that is not in the answer.`;
  }
};

/** Builds the chat messages that turn the agent's work into something worth saying out loud. */
export const buildNarrationMessages = (body: NarrateRequestBody): NarrationMessage[] => [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: buildInstruction(body) },
];

/** Cleans up what the model said, returning an empty string when it chose to say nothing. */
export const toNarrationText = (content: string | null | undefined): string => {
  const text = (content ?? '').trim().replace(/^["']|["']$/g, '');
  return text === SKIP_MARKER ? '' : text;
};
