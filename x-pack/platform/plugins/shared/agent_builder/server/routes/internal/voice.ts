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
import type { NarrateResponse, TranscribeAudioResponse } from '../../../common/http_api/voice';
import {
  MAX_NARRATION_ANSWER_LENGTH,
  MAX_NARRATION_ITEM_LENGTH,
  MAX_NARRATION_ITEMS,
  MAX_SPEECH_TEXT_LENGTH,
  MAX_TRANSCRIPTION_AUDIO_BASE64_LENGTH,
} from '../../../common/http_api/voice';
import type { NarrationMessage } from './voice_narration';
import { buildNarrationMessages, toNarrationText } from './voice_narration';
import { AGENT_BUILDER_WRITE_SECURITY } from '../route_security';

/** EIS models that accept audio input, fastest first. */
const TRANSCRIPTION_MODEL_IDS: readonly string[] = [
  'google-gemini-3.5-flash-lite',
  'google-gemini-3.6-flash',
  'google-gemini-3.7-flash',
  'google-gemini-3.8-flash',
];

/** Fast EIS chat models for the conversational voice, preferred first. */
const NARRATION_MODEL_IDS: readonly string[] = [
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

const narrateWithOpenAi = (
  { apiKey, conversationModel }: OpenAiVoiceConfig,
  messages: NarrationMessage[],
  signal: AbortSignal
): Promise<Response> =>
  fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: conversationModel, messages }),
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
  'Speak like a calm, friendly site reliability engineer briefing a colleague: natural, conversational and unhurried.';

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

  const narrationItems = schema.arrayOf(schema.string({ maxLength: MAX_NARRATION_ITEM_LENGTH }), {
    maxSize: MAX_NARRATION_ITEMS,
  });

  router.post(
    {
      path: `${internalApiPath}/voice/_narrate`,
      security: AGENT_BUILDER_WRITE_SECURITY,
      options: { access: 'internal' },
      validate: {
        body: schema.object({
          kind: schema.oneOf([
            schema.literal('start'),
            schema.literal('progress'),
            schema.literal('answer'),
          ]),
          question: schema.string({ minLength: 1, maxLength: MAX_NARRATION_ITEM_LENGTH }),
          activity: schema.maybe(narrationItems),
          said: schema.maybe(narrationItems),
          answer: schema.maybe(schema.string({ maxLength: MAX_NARRATION_ANSWER_LENGTH })),
        }),
      },
    },
    wrapHandler(async (context, request, response) => {
      const messages = buildNarrationMessages(request.body);
      const openai = getOpenAiVoice(config);
      const { signal, release } = abortWithRequest(request);
      try {
        if (openai) {
          const completion = await narrateWithOpenAi(openai, messages, signal);
          if (!completion.ok) {
            logger.warn(`OpenAI narration failed with status ${completion.status}`);
            return response.customError({
              statusCode: 502,
              body: { message: `Narration failed with status ${completion.status}` },
            });
          }
          const { choices } = (await completion.json()) as ChatCompletionResponse;
          return response.ok<NarrateResponse>({
            body: { text: toNarrationText(choices?.[0]?.message?.content) },
          });
        }

        const { elasticsearch } = await context.core;
        const esClient = elasticsearch.client.asCurrentUser;
        const { endpoints } = await esClient.inference.get({
          task_type: 'chat_completion',
          inference_id: '_all',
        });
        const inferenceId = findEisEndpoint(endpoints, NARRATION_MODEL_IDS);
        if (!inferenceId) {
          return response.notFound({
            body: { message: 'No Elastic Inference Service model is available for narration.' },
          });
        }
        const { choices } = await esClient.transport.request<ChatCompletionResponse>(
          {
            method: 'POST',
            path: `/_inference/chat_completion/${encodeURIComponent(inferenceId)}`,
            body: { messages },
          },
          { headers: { 'X-Elastic-Product-Use-Case': 'agent_builder_voice' }, signal }
        );
        return response.ok<NarrateResponse>({
          body: { text: toNarrationText(choices?.[0]?.message?.content) },
        });
      } finally {
        release();
      }
    })
  );
}
