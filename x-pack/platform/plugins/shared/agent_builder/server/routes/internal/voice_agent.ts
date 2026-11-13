/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  VoiceConverseRequestBody,
  VoiceConverseResponse,
  VoiceSpeaker,
} from '../../../common/http_api/voice';

export interface VoiceAgentMessage {
  role: 'system' | 'user';
  content: string;
}

export const ASK_ASSISTANT_TOOL_NAME = 'ask_nightshift_assistant';

const SYSTEM_PROMPT = `You are the voice on a live call with the user: a friendly, calm site reliability colleague. Working behind you is the Nightshift assistant, an investigation agent that can look into the user's systems (logs, metrics, traces, alerts, services and hosts) and act in Kibana. You cannot see any of their data yourself; only the assistant can.

Your reply is what you say out loud right now. Sound like a real person on a call, not an assistant: use contractions and everyday words, vary how you start sentences, react the way a teammate would ("oh nice", "hmm, that's not great", "okay so"), and never use stock phrases like "I'm checking that now" or "Is there anything else". Keep it short, with no markdown, lists or symbols. The user sees the assistant's written text on screen, so never read it back: talk about it the way a colleague would on a call. Say names in plain words ("the synth log stream", not "logs-synth-default"), never spell out IDs, index patterns or field names, and round numbers the way people say them. Reply with nothing at all when there is nothing worth saying.

Answer small talk and general questions yourself. Call ${ASK_ASSISTANT_TOOL_NAME} only when the user needs something looked up, checked or done in their own systems, and tell the user in a casual, varied way that you'll have a look ("let me pull that up", "one sec, I'll see what's going on with checkout"). Never call it for something it already answered or is already working on.

Only state facts about their systems that come from the assistant's activity and answers; never guess numbers, names or causes.`;

/** The one tool the voice agent has: handing a request to the Nightshift assistant. */
export const VOICE_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: ASK_ASSISTANT_TOOL_NAME,
      description:
        "Ask the Nightshift assistant to look into the user's systems or act in Kibana. It does not hear the call, so the request must be clear and standalone.",
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: 'What the assistant should find out or do, with the context it needs.',
          },
        },
        required: ['request'],
      },
    },
  },
] as const;

const SPEAKER_LABELS: Readonly<Record<VoiceSpeaker, string>> = {
  user: 'User',
  voice: 'You',
  agent: 'Assistant answered',
};

const describeAgent = ({ agent: { status, task, activity = [] } }: VoiceConverseRequestBody) => {
  if (status === 'idle') return 'The assistant is idle.';
  const steps = activity.length > 0 ? activity.map((item) => `- ${item}`).join('\n') : '(none yet)';
  return `The assistant is working on: "${
    task ?? ''
  }"\nIts recent activity, oldest first:\n${steps}`;
};

const describeTrigger = ({ trigger, answer }: VoiceConverseRequestBody): string => {
  switch (trigger) {
    case 'user':
      return `The user just spoke (the last line of the call). Reply in at most three short sentences. If they need something looked up in their systems, ask the assistant. If it is already working on that, tell them where it's at instead.`;
    case 'progress':
      return `The assistant made progress. If there is something new worth sharing, say one short sentence (at most 18 words) about it in your own words, without repeating yourself; otherwise reply with nothing. Don't call any tool.`;
    case 'answer':
      return `The assistant just finished. Its answer, which the user can see on screen:
"""
${answer ?? ''}
"""
Talk the user through it in at most three short sentences: lead with what matters most, with at most two key numbers, and mention briefly if there is more detail on screen. If the answer asks the user something, ask them. Ask the assistant again only if something the user asked for is still not covered.`;
  }
};

/** Builds the chat messages for one turn of the voice agent. */
export const buildVoiceAgentMessages = (body: VoiceConverseRequestBody): VoiceAgentMessage[] => {
  const call =
    body.transcript.length > 0
      ? body.transcript.map(({ speaker, text }) => `${SPEAKER_LABELS[speaker]}: ${text}`).join('\n')
      : '(the call just started)';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${describeAgent(body)}\n\nThe call so far:\n${call}\n\n${describeTrigger(body)}`,
    },
  ];
};

export interface VoiceAgentCompletionMessage {
  content?: string | null;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

const toAssistantRequest = (argumentsJson: string | undefined): string | undefined => {
  try {
    const { request } = JSON.parse(argumentsJson ?? '{}') as { request?: unknown };
    return typeof request === 'string' && request.trim() ? request.trim() : undefined;
  } catch {
    return undefined;
  }
};

/** Reads what the voice agent says, and the request it hands to the assistant, if any. */
export const parseVoiceAgentReply = (
  message: VoiceAgentCompletionMessage | undefined
): VoiceConverseResponse => {
  const say = (message?.content ?? '').trim();
  const call = message?.tool_calls?.find(
    ({ function: fn }) => fn?.name === ASK_ASSISTANT_TOOL_NAME
  );
  const askAgent = toAssistantRequest(call?.function?.arguments);
  return askAgent ? { say, askAgent } : { say };
};
