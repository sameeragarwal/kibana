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

/** Why the voice agent is asked to speak: the user said something, or the assistant moved on. */
export type VoiceTrigger = 'user' | 'progress' | 'answer';

export type VoiceSpeaker = 'user' | 'voice' | 'agent';

export interface VoiceTranscriptEntry {
  speaker: VoiceSpeaker;
  text: string;
}

export interface VoiceAgentState {
  status: 'idle' | 'working';
  /** What the voice asked the assistant to do. */
  task?: string;
  /** The assistant's recent progress messages and steps, oldest first. */
  activity?: string[];
}

export const MAX_VOICE_TRANSCRIPT_ENTRIES = 40;
export const MAX_VOICE_ACTIVITY_ITEMS = 20;
export const MAX_VOICE_TEXT_LENGTH = 4000;
export const MAX_VOICE_ANSWER_LENGTH = 20_000;

export interface VoiceConverseRequestBody {
  trigger: VoiceTrigger;
  /** The call so far, oldest first; for `user`, it ends with what the user just said. */
  transcript: VoiceTranscriptEntry[];
  agent: VoiceAgentState;
  /** The assistant's written answer, for `answer`. */
  answer?: string;
}

export interface VoiceConverseResponse {
  /** What to say out loud; empty to stay quiet. */
  say: string;
  /** A request for the assistant, when the user needs something looked up. */
  askAgent?: string;
}
