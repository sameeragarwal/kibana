/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** Fits a minute of 16 kHz, 16-bit mono WAV once base64 encoded. */
export const MAX_TRANSCRIPTION_AUDIO_BASE64_LENGTH = 3 * 1024 * 1024;

export interface TranscribeAudioRequestBody {
  /** Base64-encoded WAV recording. */
  audio: string;
}

export interface TranscribeAudioResponse {
  /** What was said, or an empty string when the recording has no speech. */
  transcript: string;
}

/** Longest text spoken in one request; replies are sent a sentence at a time. */
export const MAX_SPEECH_TEXT_LENGTH = 1000;

export interface SpeakTextRequestBody {
  text: string;
}

/** What the voice should say: an acknowledgement, a progress update or the answer itself. */
export type NarrationKind = 'start' | 'progress' | 'answer';

export const MAX_NARRATION_ITEMS = 20;
export const MAX_NARRATION_ITEM_LENGTH = 1000;
export const MAX_NARRATION_ANSWER_LENGTH = 20_000;

export interface NarrateRequestBody {
  kind: NarrationKind;
  /** What the user asked. */
  question: string;
  /** The agent's recent progress messages and tool steps, oldest first. */
  activity?: string[];
  /** What the voice already said this turn, so it doesn't repeat itself. */
  said?: string[];
  /** The agent's written answer, for `answer`. */
  answer?: string;
}

export interface NarrateResponse {
  /** What to say; empty when there is nothing new worth saying. */
  text: string;
}
