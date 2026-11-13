/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type { NarrateRequestBody } from '../../../../../common/http_api/voice';
import type { Microphone } from './record_utterance';
import { openMicrophone, recordUtterance, toTranscriptionAudio } from './record_utterance';
import type { SynthesizeSpeech } from './speech_player';
import { createBrowserSpeechPlayer, ProviderSpeechPlayer } from './speech_player';
import { LISTENING_CUE_MS, playHeardCue, playListeningCue, startThinkingSound } from './voice_cues';

interface FeaturePolicy {
  allowsFeature: (feature: string) => boolean;
}

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export type VoiceErrorCode = 'not-allowed' | 'audio-capture' | 'transcription-failed' | 'unknown';

export interface VoiceError {
  code: VoiceErrorCode;
  reason?: string;
}

export interface VoiceSessionBinding {
  /** Turns a base64 WAV recording into text. */
  transcribe: (audio: string, signal: AbortSignal) => Promise<string>;
  /** Sends what the user said to the agent, returning whether it could be sent. */
  send: (message: string) => boolean;
  /** Turns text into audio with the configured voice provider; the browser speaks otherwise. */
  synthesize?: SynthesizeSpeech;
  /** Puts the agent's work into words worth saying; progress is read verbatim otherwise. */
  narrate?: (request: NarrateRequestBody, signal: AbortSignal) => Promise<string>;
  onError: (error: VoiceError) => void;
}

// Browsers without a policy API (Safari, Firefox) report a blocked microphone when it is opened.
const isMicrophoneAllowed = (): boolean => {
  const { permissionsPolicy, featurePolicy } = document as Document & {
    permissionsPolicy?: FeaturePolicy;
    featurePolicy?: FeaturePolicy;
  };
  return (permissionsPolicy ?? featurePolicy)?.allowsFeature('microphone') ?? true;
};

/** Whether this browser and page can both record the user and speak back. */
export const isVoiceConversationSupported = (): boolean =>
  typeof navigator.mediaDevices?.getUserMedia === 'function' &&
  typeof MediaRecorder !== 'undefined' &&
  'speechSynthesis' in window &&
  isMicrophoneAllowed();

const toMicrophoneError = (error: unknown): VoiceError => {
  const name = error instanceof DOMException ? error.name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError') return { code: 'not-allowed' };
  if (name === 'NotFoundError' || name === 'NotReadableError') return { code: 'audio-capture' };
  return { code: 'unknown', reason: error instanceof Error ? error.message : String(error) };
};

const getErrorReason = (error: unknown): string | undefined => {
  const { body, message } = (error ?? {}) as { body?: { message?: string }; message?: string };
  return body?.message ?? message;
};

// Chrome cuts off a single utterance after about 15 seconds, so replies are spoken per sentence.
const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

// Gives a remounting input (a new conversation swaps the empty screen for the timeline) time to
// bind again before an unbound session is treated as abandoned.
const UNBOUND_GRACE_MS = 1000;

// While the agent works, the voice says something about its new activity once it has been quiet
// this long, so the turn feels like a conversation rather than a wait.
const QUIET_BEFORE_PROGRESS_MS = 4000;
const PROGRESS_CHECK_MS = 1000;
// How much of the turn the voice is reminded of each time it speaks.
const RECENT_ACTIVITY = 8;
const RECENT_SAID = 6;

interface TurnState {
  question: string;
  /** The agent's progress messages and steps so far, oldest first. */
  activity: string[];
  /** What the voice said this turn. */
  said: string[];
  /** How much of the activity the voice has already talked about. */
  coveredActivity: number;
  lastSpokeAt: number;
  isNarrating: boolean;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the message shown to the user when the voice conversation fails. */
export const getVoiceErrorMessage = ({ code, reason }: VoiceError): string => {
  switch (code) {
    case 'not-allowed':
      return i18n.translate('xpack.agentBuilder.conversationInput.voice.notAllowedError', {
        defaultMessage:
          'Microphone access is blocked. Allow it in your browser to talk to the agent.',
      });
    case 'audio-capture':
      return i18n.translate('xpack.agentBuilder.conversationInput.voice.noMicrophoneError', {
        defaultMessage: 'No microphone was found. Connect one and try again.',
      });
    case 'transcription-failed':
      return i18n.translate('xpack.agentBuilder.conversationInput.voice.transcriptionError', {
        defaultMessage: "Couldn't understand the recording: {reason}",
        values: { reason },
      });
    default:
      return i18n.translate('xpack.agentBuilder.conversationInput.voice.genericError', {
        defaultMessage: 'Voice conversation stopped because of an error ({reason}).',
        values: { reason },
      });
  }
};

/**
 * One hands-free conversation loop for the page: listen, send what was said, speak the reply,
 * listen again. Kept outside React because the chat input remounts while a conversation is created.
 */
export class VoiceSession {
  private phase: VoicePhase = 'idle';
  private readonly listeners = new Set<() => void>();
  private microphone: Microphone | undefined;
  private turn: AbortController | undefined;
  private binding: VoiceSessionBinding | undefined;
  private unboundTimer: ReturnType<typeof setTimeout> | undefined;
  // Rounds the user has already seen or heard; only a round created after they speak is read out.
  private readonly handledRoundIds = new Set<string>();
  private stopThinkingSound: (() => void) | undefined;
  private turnState: TurnState | undefined;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private readonly player = new ProviderSpeechPlayer({
    synthesize: (text, signal) =>
      this.binding?.synthesize?.(text, signal) ?? Promise.resolve(undefined),
    isEnabled: () => Boolean(this.binding?.synthesize),
    fallback: createBrowserSpeechPlayer(),
  });

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getPhase = (): VoicePhase => this.phase;

  bind(binding: VoiceSessionBinding): () => void {
    clearTimeout(this.unboundTimer);
    this.binding = binding;
    return () => {
      if (this.binding !== binding) return;
      this.binding = undefined;
      this.unboundTimer = setTimeout(() => {
        if (!this.binding) this.stop();
      }, UNBOUND_GRACE_MS);
    };
  }

  start(): void {
    if (this.phase !== 'idle') return;
    void this.listen();
  }

  stop(): void {
    this.turn?.abort();
    this.turn = undefined;
    this.microphone?.release();
    this.microphone = undefined;
    this.player.cancel();
    this.setPhase('idle');
  }

  /** Marks rounds that are not a reply to the message being waited on. */
  markHandled(roundIds: readonly string[]): void {
    roundIds.forEach((roundId) => this.handledRoundIds.add(roundId));
  }

  /** Whether the round is the reply to what the user just said. */
  isAwaitedReply(roundId: string): boolean {
    return this.phase === 'thinking' && !this.handledRoundIds.has(roundId);
  }

  /** Records something the agent wrote or did while the user waits; the voice talks about it. */
  addActivity(text: string): void {
    const state = this.turnState;
    if (this.phase !== 'thinking' || !state || !text || state.activity.includes(text)) return;
    state.activity.push(text);
  }

  /**
   * Speaks the reply to what the user just said, then listens again unless told to stop. A written
   * answer is retold by the voice; `text` is read as is when there is no voice or it fails.
   */
  speakReply(
    roundId: string,
    { markdown, text }: { markdown?: string; text: string },
    { thenListen }: { thenListen: boolean }
  ): void {
    if (!this.isAwaitedReply(roundId)) return;
    this.handledRoundIds.add(roundId);
    const state = this.turnState;
    if (!markdown || !state) {
      this.speak(text, thenListen);
      return;
    }
    this.setPhase('speaking');
    void this.narrateTurn(
      { kind: 'answer', question: state.question, answer: markdown },
      () => text
    ).then((spoken) => {
      if (this.phase !== 'speaking' || this.turnState !== state) return;
      this.speak(spoken || text, thenListen);
    });
  }

  private speak(text: string, thenListen: boolean): void {
    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      this.continueOrStop(thenListen);
      return;
    }
    // Queued behind any progress sentence still being spoken, so nothing is cut off mid-word.
    this.setPhase('speaking');
    sentences.forEach((sentence, index) => {
      const isLast = index === sentences.length - 1;
      this.player.speak(
        sentence,
        isLast
          ? () => {
              if (this.phase === 'speaking') this.continueOrStop(thenListen);
            }
          : undefined
      );
    });
  }

  private continueOrStop(thenListen: boolean): void {
    if (thenListen) void this.listen();
    else this.stop();
  }

  private async listen(): Promise<void> {
    this.turn?.abort();
    const turn = new AbortController();
    this.turn = turn;
    const { signal } = turn;
    this.setPhase('listening');

    let microphone = this.microphone;
    try {
      microphone ??= await openMicrophone();
    } catch (error) {
      this.fail(signal, toMicrophoneError(error));
      return;
    }
    if (signal.aborted) {
      if (microphone !== this.microphone) microphone.release();
      return;
    }
    this.microphone = microphone;

    playListeningCue();
    await wait(LISTENING_CUE_MS);
    if (signal.aborted) return;

    const recording = await recordUtterance(microphone, signal);
    if (signal.aborted) return;
    if (!recording || !this.binding) {
      this.stop();
      return;
    }

    playHeardCue();
    this.setPhase('transcribing');
    let transcript: string;
    try {
      transcript = await this.binding.transcribe(await toTranscriptionAudio(recording), signal);
    } catch (error) {
      this.fail(signal, { code: 'transcription-failed', reason: getErrorReason(error) });
      return;
    }
    if (signal.aborted) return;
    if (!transcript || !this.binding) {
      this.stop();
      return;
    }

    this.setPhase('thinking');
    const state: TurnState = {
      question: transcript,
      activity: [],
      said: [],
      coveredActivity: 0,
      lastSpokeAt: Date.now(),
      isNarrating: false,
    };
    this.turnState = state;
    if (!this.binding.send(transcript)) {
      this.stop();
      return;
    }
    this.progressTimer = setInterval(() => this.talkAboutProgress(state), PROGRESS_CHECK_MS);
    void this.say(state, { kind: 'start', question: transcript }, () => '');
  }

  private talkAboutProgress(state: TurnState): void {
    if (this.player.isSpeaking()) {
      state.lastSpokeAt = Date.now();
      return;
    }
    if (state.isNarrating || state.activity.length <= state.coveredActivity) return;
    if (Date.now() - state.lastSpokeAt < QUIET_BEFORE_PROGRESS_MS) return;
    const covered = state.activity.length;
    void this.say(
      state,
      {
        kind: 'progress',
        question: state.question,
        activity: state.activity.slice(-RECENT_ACTIVITY),
        said: state.said.slice(-RECENT_SAID),
      },
      () => state.activity[covered - 1]
    ).then(() => {
      state.coveredActivity = covered;
    });
  }

  /** Asks the voice what to say while the agent works, and says it if the agent is still working. */
  private async say(
    state: TurnState,
    request: NarrateRequestBody,
    fallback: () => string
  ): Promise<void> {
    state.isNarrating = true;
    const text = await this.narrateTurn(request, fallback);
    state.isNarrating = false;
    if (this.turnState !== state || this.phase !== 'thinking' || !text) return;
    state.said.push(text);
    state.lastSpokeAt = Date.now();
    this.player.speak(text);
  }

  private async narrateTurn(request: NarrateRequestBody, fallback: () => string): Promise<string> {
    const narrate = this.binding?.narrate;
    const signal = this.turn?.signal;
    if (!narrate || !signal) return fallback();
    try {
      return await narrate(request, signal);
    } catch {
      return signal.aborted ? '' : fallback();
    }
  }

  private fail(signal: AbortSignal, error: VoiceError): void {
    if (signal.aborted) return;
    this.binding?.onError(error);
    this.stop();
  }

  private setPhase(phase: VoicePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase === 'transcribing' || phase === 'thinking') {
      this.stopThinkingSound ??= startThinkingSound(() => this.player.isSpeaking());
    } else {
      this.stopThinkingSound?.();
      this.stopThinkingSound = undefined;
    }
    if (phase !== 'thinking') {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.listeners.forEach((listener) => listener());
  }
}

export const voiceSession = new VoiceSession();
