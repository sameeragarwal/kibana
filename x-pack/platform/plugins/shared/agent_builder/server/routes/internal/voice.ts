/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { InferenceInferenceEndpointInfo } from '@elastic/elasticsearch/lib/api/types';
import type { KibanaRequest } from '@kbn/core/server';
import type { RouteDependencies } from '../types';
import type { AgentBuilderConfig } from '../../config';
import { getHandlerWrapper } from '../wrap_handler';
import { internalApiPath } from '../../../common/constants';
import type {
  TranscribeAudioResponse,
  VoiceConverseResponse,
} from '../../../common/http_api/voice';
import {
  MAX_SPEECH_TEXT_LENGTH,
  MAX_TRANSCRIPTION_AUDIO_BASE64_LENGTH,
  MAX_VOICE_ACTIVITY_ITEMS,
  MAX_VOICE_ANSWER_LENGTH,
  MAX_VOICE_TEXT_LENGTH,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
} from '../../../common/http_api/voice';
import type { VoiceAgentCompletionMessage, VoiceAgentMessage } from './voice_agent';
import { buildVoiceAgentMessages, parseVoiceAgentReply, VOICE_AGENT_TOOLS } from './voice_agent';
import { AGENT_BUILDER_WRITE_SECURITY } from '../route_security';

/** EIS models that accept audio input, fastest first. */
const TRANSCRIPTION_MODEL_IDS: readonly string[] = [
  'google-gemini-3.5-flash-lite',
  'google-gemini-3.6-flash',
  'google-gemini-3.7-flash',
  'google-gemini-3.8-flash',
];

/** Fast EIS chat models for the voice agent, preferred first. */
const VOICE_AGENT_MODEL_IDS: readonly string[] = [
  'google-gemini-3.5-flash',
  'google-gemini-3.5-flash-lite',
  'google-gemini-3.6-flash',
];

const NO_SPEECH_MARKER = '[no speech]';

// Keep this free of topic or vocabulary hints: with any hint, the model invents a plausible
// request when it hears silence.
const TRANSCRIPTION_PROMPT = `Transcribe only the words actually spoken in this recording, verbatim, in the language they are spoken. Do not guess, complete or invent words. Reply with the transcript only, without quotes or commentary. If you cannot clearly hear speech, reply with exactly ${NO_SPEECH_MARKER}`;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface VoiceAgentCompletion {
  choices?: Array<{ message?: VoiceAgentCompletionMessage }>;
}

const findEisEndpoint = (
  endpoints: InferenceInferenceEndpointInfo[],
  modelIds: readonly string[]
): string | undefined => {
  const [endpoint] = endpoints
    .filter(
      ({ service, service_settings: settings }) =>
        service === 'elastic' && modelIds.includes(String(settings?.model_id))
    )
    .sort(
      (left, right) =>
        modelIds.indexOf(String(left.service_settings?.model_id)) -
        modelIds.indexOf(String(right.service_settings?.model_id))
    );
  return endpoint?.inference_id;
};

/** Picks the preferred Elastic Inference Service chat endpoint that can listen to audio. */
export const findTranscriptionEndpoint = (
  endpoints: InferenceInferenceEndpointInfo[]
): string | undefined => findEisEndpoint(endpoints, TRANSCRIPTION_MODEL_IDS);

/** Reads the transcript out of a chat completion, treating the no-speech reply as empty. */
export const toTranscript = ({ choices }: ChatCompletionResponse): string => {
  const transcript = choices?.[0]?.message?.content?.trim() ?? '';
  return transcript === NO_SPEECH_MARKER ? '' : transcript;
};

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

type OpenAiVoiceConfig = NonNullable<AgentBuilderConfig['voice']['openai']>;

const getOpenAiVoice = (config: AgentBuilderConfig | undefined): OpenAiVoiceConfig | undefined =>
  config?.voice.useEis === false ? config.voice.openai : undefined;

// Stops the upstream call when the browser gives up on the request (the user turned voice off).
const abortWithRequest = (request: KibanaRequest): { signal: AbortSignal; release: () => void } => {
  const controller = new AbortController();
  const subscription = request.events.aborted$.subscribe(() => controller.abort());
  return { signal: controller.signal, release: () => subscription.unsubscribe() };
};

const converseWithOpenAi = (
  { apiKey, conversationModel }: OpenAiVoiceConfig,
  messages: VoiceAgentMessage[],
  signal: AbortSignal
): Promise<Response> =>
  fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: conversationModel,
      messages,
      tools: VOICE_AGENT_TOOLS,
    }),
    signal,
  });

const transcribeWithOpenAi = async (
  { apiKey, transcriptionModel }: OpenAiVoiceConfig,
  audio: string,
  signal: AbortSignal
): Promise<Response> => {
  const form = new FormData();
  form.append('model', transcriptionModel);
  form.append(
    'file',
    new Blob([Buffer.from(audio, 'base64')], { type: 'audio/wav' }),
    'speech.wav'
  );
  return fetch(OPENAI_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  });
};

const SPEECH_INSTRUCTIONS =
  'You are on a relaxed phone call with a teammate. Talk the way people actually talk, not like reading aloud: warm, easygoing, with natural rhythm, small pauses and varied intonation. Sound genuinely engaged, a little upbeat for good news and calmly concerned for problems.';

export function registerInternalVoiceRoutes({ router, logger, config }: RouteDependencies) {
  const wrapHandler = getHandlerWrapper({ logger });

  router.post(
    {
      path: `${internalApiPath}/voice/_transcribe`,
      security: AGENT_BUILDER_WRITE_SECURITY,
      options: {
        access: 'internal',
        body: { maxBytes: MAX_TRANSCRIPTION_AUDIO_BASE64_LENGTH + 1024 },
      },
      validate: {
        body: schema.object({
          audio: schema.string({ minLength: 1, maxLength: MAX_TRANSCRIPTION_AUDIO_BASE64_LENGTH }),
        }),
      },
    },
    wrapHandler(async (context, request, response) => {
      const openai = getOpenAiVoice(config);
      if (openai) {
        const { signal, release } = abortWithRequest(request);
        try {
          const transcription = await transcribeWithOpenAi(openai, request.body.audio, signal);
          if (!transcription.ok) {
            logger.warn(`OpenAI transcription failed with status ${transcription.status}`);
            return response.customError({
              statusCode: 502,
              body: { message: `Transcription failed with status ${transcription.status}` },
            });
          }
          const { text } = (await transcription.json()) as { text?: string };
          return response.ok<TranscribeAudioResponse>({
            body: { transcript: text?.trim() ?? '' },
          });
        } finally {
          release();
        }
      }

      const { elasticsearch } = await context.core;
      const esClient = elasticsearch.client.asCurrentUser;

      const { endpoints } = await esClient.inference.get({
        task_type: 'chat_completion',
        inference_id: '_all',
      });
      const inferenceId = findTranscriptionEndpoint(endpoints);
      if (!inferenceId) {
        return response.notFound({
          body: {
            message: 'No Elastic Inference Service model that understands speech is available.',
          },
        });
      }

      const completion = await esClient.transport.request<ChatCompletionResponse>(
        {
          method: 'POST',
          path: `/_inference/chat_completion/${encodeURIComponent(inferenceId)}`,
          body: {
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: TRANSCRIPTION_PROMPT },
                  {
                    type: 'file',
                    file: {
                      file_data: `data:audio/wav;base64,${request.body.audio}`,
                      filename: 'speech.wav',
                    },
                  },
                ],
              },
            ],
          },
        },
        { headers: { 'X-Elastic-Product-Use-Case': 'agent_builder_voice' } }
      );

      return response.ok<TranscribeAudioResponse>({
        body: { transcript: toTranscript(completion) },
      });
    })
  );

  router.post(
    {
      path: `${internalApiPath}/voice/_speak`,
      security: AGENT_BUILDER_WRITE_SECURITY,
      options: { access: 'internal' },
      validate: {
        body: schema.object({
          text: schema.string({ minLength: 1, maxLength: MAX_SPEECH_TEXT_LENGTH }),
        }),
      },
    },
    wrapHandler(async (context, request, response) => {
      const speech = getOpenAiVoice(config);
      if (!speech) {
        return response.notFound({
          body: { message: 'Voice replies use the browser voice unless voice.useEis is false.' },
        });
      }

      const { signal, release } = abortWithRequest(request);
      try {
        const speechResponse = await fetch(OPENAI_SPEECH_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${speech.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: speech.speechModel,
            voice: speech.voice,
            input: request.body.text,
            instructions: SPEECH_INSTRUCTIONS,
            response_format: 'mp3',
          }),
          signal,
        });
        if (!speechResponse.ok) {
          logger.warn(`OpenAI text-to-speech failed with status ${speechResponse.status}`);
          return response.customError({
            statusCode: 502,
            body: { message: `Text-to-speech failed with status ${speechResponse.status}` },
          });
        }
        return response.ok({
          body: Buffer.from(await speechResponse.arrayBuffer()),
          headers: { 'content-type': 'audio/mpeg' },
        });
      } finally {
        release();
      }
    })
  );

  const voiceText = schema.string({ maxLength: MAX_VOICE_TEXT_LENGTH });

  router.post(
    {
      path: `${internalApiPath}/voice/_converse`,
      security: AGENT_BUILDER_WRITE_SECURITY,
      options: { access: 'internal' },
      validate: {
        body: schema.object({
          trigger: schema.oneOf([
            schema.literal('user'),
            schema.literal('progress'),
            schema.literal('answer'),
          ]),
          transcript: schema.arrayOf(
            schema.object({
              speaker: schema.oneOf([
                schema.literal('user'),
                schema.literal('voice'),
                schema.literal('agent'),
              ]),
              text: voiceText,
            }),
            { maxSize: MAX_VOICE_TRANSCRIPT_ENTRIES }
          ),
          agent: schema.object({
            status: schema.oneOf([schema.literal('idle'), schema.literal('working')]),
            task: schema.maybe(voiceText),
            activity: schema.maybe(
              schema.arrayOf(voiceText, { maxSize: MAX_VOICE_ACTIVITY_ITEMS })
            ),
          }),
          answer: schema.maybe(schema.string({ maxLength: MAX_VOICE_ANSWER_LENGTH })),
        }),
      },
    },
    wrapHandler(async (context, request, response) => {
      const messages = buildVoiceAgentMessages(request.body);
      const openai = getOpenAiVoice(config);
      const { signal, release } = abortWithRequest(request);
      try {
        if (openai) {
          const completion = await converseWithOpenAi(openai, messages, signal);
          if (!completion.ok) {
            logger.warn(`OpenAI voice agent failed with status ${completion.status}`);
            return response.customError({
              statusCode: 502,
              body: { message: `The voice agent failed with status ${completion.status}` },
            });
          }
          const { choices } = (await completion.json()) as VoiceAgentCompletion;
          return response.ok<VoiceConverseResponse>({
            body: parseVoiceAgentReply(choices?.[0]?.message),
          });
        }

        const { elasticsearch } = await context.core;
        const esClient = elasticsearch.client.asCurrentUser;
        const { endpoints } = await esClient.inference.get({
          task_type: 'chat_completion',
          inference_id: '_all',
        });
        const inferenceId = findEisEndpoint(endpoints, VOICE_AGENT_MODEL_IDS);
        if (!inferenceId) {
          return response.notFound({
            body: {
              message: 'No Elastic Inference Service model is available for the voice agent.',
            },
          });
        }
        const { choices } = await esClient.transport.request<VoiceAgentCompletion>(
          {
            method: 'POST',
            path: `/_inference/chat_completion/${encodeURIComponent(inferenceId)}`,
            body: { messages, tools: VOICE_AGENT_TOOLS },
          },
          { headers: { 'X-Elastic-Product-Use-Case': 'agent_builder_voice' }, signal }
        );
        return response.ok<VoiceConverseResponse>({
          body: parseVoiceAgentReply(choices?.[0]?.message),
        });
      } finally {
        release();
      }
    })
  );
}
