/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';
import type {
  VoiceConverseRequestBody,
  VoiceConverseResponse,
  VoiceTranscriptEntry,
} from '../../../../../common/http_api/voice';
import {
  MAX_VOICE_ACTIVITY_ITEMS,
  MAX_VOICE_ANSWER_LENGTH,
  MAX_VOICE_TEXT_LENGTH,
  MAX_VOICE_TRANSCRIPT_ENTRIES,
} from '../../../../../common/http_api/voice';
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
  /** Hands a request to the agent, returning whether it could be sent. */
  send: (message: string) => boolean;
  /** Turns text into audio with the configured voice provider; the browser speaks otherwise. */
  synthesize?: SynthesizeSpeech;
  /** Asks the voice agent what to say; without one, requests go to the agent and replies are read. */
  converse?: (
    request: VoiceConverseRequestBody,
    signal: AbortSignal
  ) => Promise<VoiceConverseResponse>;
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

// Gives a remounting input (a new conversation swaps the empty screen for the timeline) time to
// bind again before an unbound session is treated as abandoned.
const UNBOUND_GRACE_MS = 1000;

// While the agent works, the voice mentions its new activity once the call has been quiet this
// long, so waiting on it feels like a conversation.
const QUIET_BEFORE_PROGRESS_MS = 4000;
const PROGRESS_CHECK_MS = 1000;

type VoiceEvent =
  | { type: 'user'; text: string }
  | { type: 'progress' }
  | { type: 'answer'; markdown: string; text: string }
  | { type: 'prompt'; text: string };

/** What a listen ended with: something the user said, silence, or an event to talk about. */
type Heard = { type: 'user'; text: string } | { type: 'silence' } | { type: 'interrupted' };

interface AgentTask {
  request: string;
  /** The agent's progress messages and steps so far, oldest first. */
  activity: string[];
  /** How much of the activity the voice has had the chance to talk about. */
  covered: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

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
 * One hands-free call for the page. The voice talks with the user and hands requests to the agent,
 * listening while the agent works and talking about its progress and answers as they come in.
 * Kept outside React because the chat input remounts while a conversation is created.
 */
export class VoiceSession {
  private phase: VoicePhase = 'idle';
  private readonly listeners = new Set<() => void>();
  private microphone: Microphone | undefined;
  private session: AbortController | undefined;
  private listening: AbortController | undefined;
  private isUserTalking = false;
  private binding: VoiceSessionBinding | undefined;
  private unboundTimer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  // Rounds the user has already seen or heard; only a round created for the agent's task is retold.
  private readonly handledRoundIds = new Set<string>();
  private stopThinkingSound: (() => void) | undefined;
  private events: VoiceEvent[] = [];
  private transcript: VoiceTranscriptEntry[] = [];
  private task: AgentTask | undefined;
  // A request made while the agent was busy, sent once it is done.
  private pendingRequest: string | undefined;
  private lastSpokeAt = 0;
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

  /** Whether the agent is working on something the voice asked it for. */
  isAwaitingAgent = (): boolean => this.task !== undefined;

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
    if (this.session) return;
    const session = new AbortController();
    this.session = session;
    this.events = [];
    this.transcript = [];
    this.lastSpokeAt = Date.now();
    this.progressTimer = setInterval(() => this.checkOnAgent(), PROGRESS_CHECK_MS);
    void this.run(session.signal);
  }

  stop(): void {
    this.session?.abort();
    this.session = undefined;
    this.listening = undefined;
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
    this.microphone?.release();
    this.microphone = undefined;
    this.player.cancel();
    this.events = [];
    this.pendingRequest = undefined;
    this.setTask(undefined);
    this.setPhase('idle');
  }

  /** Marks rounds that are not the agent's answer to the task being waited on. */
  markHandled(roundIds: readonly string[]): void {
    roundIds.forEach((roundId) => this.handledRoundIds.add(roundId));
  }

  /** Whether the round is the agent's answer to the task being waited on. */
  isAwaitedReply(roundId: string): boolean {
    return this.task !== undefined && !this.handledRoundIds.has(roundId);
  }

  /** Records something the agent wrote or did for the task; the voice talks about it. */
  addActivity(text: string): void {
    const { task } = this;
    if (!task || !text || task.activity.includes(text)) return;
    task.activity.push(text);
  }

  /** Hands the agent's answer to the voice; `text` is read as is when there is no voice agent. */
  agentAnswered(roundId: string, { markdown, text }: { markdown: string; text: string }): void {
    if (!this.isAwaitedReply(roundId)) return;
    this.handledRoundIds.add(roundId);
    this.setTask(undefined);
    this.pushEvent({ type: 'answer', markdown, text });
  }

  /** Reads out what the agent needs the user to confirm, then ends the call so they can act. */
  agentPrompted(roundId: string, text: string): void {
    if (!this.isAwaitedReply(roundId)) return;
    this.handledRoundIds.add(roundId);
    this.setTask(undefined);
    this.pushEvent({ type: 'prompt', text });
  }

  /** Stops waiting on an agent run that ended without an answer. */
  agentFailed(): void {
    this.setTask(undefined);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let cue = true;
    while (!signal.aborted) {
      const event = this.events.shift();
      if (event) {
        if (event.type === 'prompt') {
          await this.speak(event.text, signal);
          if (!signal.aborted) this.stop();
          return;
        }
        await this.respond(event, signal);
        continue;
      }

      // The cue only opens the call; after that the voice finishing is the user's turn to talk.
      const heard = await this.listen(signal, cue);
      cue = false;
      if (signal.aborted) return;
      if (heard.type === 'user') {
        this.events.unshift(heard);
      } else if (
        heard.type === 'silence' &&
        !this.task &&
        !this.pendingRequest &&
        this.events.length === 0
      ) {
        this.stop();
        return;
      }
    }
  }

  /** Listens until the user says something, stays silent, or an event needs talking about. */
  private async listen(signal: AbortSignal, cue: boolean): Promise<Heard> {
    const listening = new AbortController();
    const stopListening = () => listening.abort();
    signal.addEventListener('abort', stopListening);
    this.listening = listening;
    this.isUserTalking = false;
    this.setPhase('listening');
    try {
      return await this.hear(signal, listening.signal, cue);
    } finally {
      signal.removeEventListener('abort', stopListening);
      this.isUserTalking = false;
      if (this.listening === listening) this.listening = undefined;
    }
  }

  private async hear(signal: AbortSignal, listening: AbortSignal, cue: boolean): Promise<Heard> {
    let microphone = this.microphone;
    try {
      microphone ??= await openMicrophone();
    } catch (error) {
      this.fail(signal, toMicrophoneError(error));
      return { type: 'silence' };
    }
    if (signal.aborted) {
      if (microphone !== this.microphone) microphone.release();
      return { type: 'silence' };
    }
    this.microphone = microphone;

    if (cue) {
      playListeningCue();
      await wait(LISTENING_CUE_MS);
    }
    if (listening.aborted) return { type: 'interrupted' };

    const recording = await recordUtterance(microphone, listening, () => {
      this.isUserTalking = true;
    });
    if (listening.aborted) return { type: 'interrupted' };
    if (!recording || !this.binding) return { type: 'silence' };

    playHeardCue();
    this.setPhase('transcribing');
    this.stopThinkingSound ??= startThinkingSound(() => this.player.isSpeaking());
    let text: string;
    try {
      text = await this.binding.transcribe(await toTranscriptionAudio(recording), signal);
    } catch (error) {
      this.fail(signal, { code: 'transcription-failed', reason: getErrorReason(error) });
      return { type: 'silence' };
    }
    return text ? { type: 'user', text } : { type: 'silence' };
  }

  /** Lets the voice respond to an event, returning whether it said anything. */
  private async respond(
    event: Exclude<VoiceEvent, { type: 'prompt' }>,
    signal: AbortSignal
  ): Promise<boolean> {
    if (event.type === 'user') {
      this.addToTranscript({ speaker: 'user', text: event.text });
      this.stopThinkingSound ??= startThinkingSound(() => this.player.isSpeaking());
    }
    if (event.type === 'progress' && this.task) this.task.covered = this.task.activity.length;
    this.setPhase('thinking');

    const { say, askAgent } = await this.converse(event, signal);
    if (signal.aborted) return false;
    if (event.type === 'answer') {
      this.addToTranscript({
        speaker: 'agent',
        text: truncate(event.markdown, MAX_VOICE_TEXT_LENGTH),
      });
    }
    if (askAgent) this.askAgent(askAgent);
    if (!say) return false;
    this.addToTranscript({ speaker: 'voice', text: say });
    await this.speak(say, signal);
    return true;
  }

  private async converse(
    event: Exclude<VoiceEvent, { type: 'prompt' }>,
    signal: AbortSignal
  ): Promise<VoiceConverseResponse> {
    const fallback = (): VoiceConverseResponse => {
      switch (event.type) {
        case 'user':
          return { say: '', askAgent: event.text };
        case 'progress':
          return { say: this.task?.activity.at(-1) ?? '' };
        case 'answer':
          return { say: event.text };
      }
    };
    const converse = this.binding?.converse;
    if (!converse) return fallback();
    const { task } = this;
    try {
      return await converse(
        {
          trigger: event.type,
          transcript: this.transcript,
          agent: task
            ? {
                status: 'working',
                task: truncate(task.request, MAX_VOICE_TEXT_LENGTH),
                activity: task.activity
                  .slice(-MAX_VOICE_ACTIVITY_ITEMS)
                  .map((item) => truncate(item, MAX_VOICE_TEXT_LENGTH)),
              }
            : { status: 'idle' },
          ...(event.type === 'answer'
            ? { answer: truncate(event.markdown, MAX_VOICE_ANSWER_LENGTH) }
            : {}),
        },
        signal
      );
    } catch {
      return signal.aborted ? { say: '' } : fallback();
    }
  }

  /** Hands a request to the agent now, or once it finishes what it is working on. */
  private askAgent(request: string): void {
    if (this.task) {
      this.pendingRequest = request;
      return;
    }
    this.pendingRequest = undefined;
    this.setTask({ request, activity: [], covered: 0 });
    if (!this.binding?.send(request)) this.setTask(undefined);
  }

  /** Speaks text, resolving once it has been heard or the call ends. */
  private speak(text: string, signal: AbortSignal): Promise<void> {
    if (!text.trim() || signal.aborted) return Promise.resolve();
    this.setPhase('speaking');
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        this.lastSpokeAt = Date.now();
        resolve();
      };
      signal.addEventListener('abort', done);
      this.player.speak(text, done);
    });
  }

  /** Lets the voice talk about the agent's progress during a quiet moment, and sends what's queued. */
  private checkOnAgent(): void {
    const { task } = this;
    if (!task) {
      if (this.pendingRequest && this.phase === 'listening' && !this.isUserTalking) {
        this.askAgent(this.pendingRequest);
      }
      return;
    }
    if (this.phase !== 'listening' || this.isUserTalking) return;
    if (task.activity.length <= task.covered) return;
    if (Date.now() - this.lastSpokeAt < QUIET_BEFORE_PROGRESS_MS) return;
    if (this.events.some(({ type }) => type === 'progress')) return;
    this.pushEvent({ type: 'progress' });
  }

  private pushEvent(event: VoiceEvent): void {
    if (!this.session) return;
    this.events.push(event);
    if (!this.isUserTalking) this.listening?.abort();
  }

  private addToTranscript(entry: VoiceTranscriptEntry): void {
    this.transcript = [...this.transcript, entry].slice(-MAX_VOICE_TRANSCRIPT_ENTRIES);
  }

  private setTask(task: AgentTask | undefined): void {
    if (this.task === task) return;
    const wasAwaiting = this.task !== undefined;
    this.task = task;
    if (wasAwaiting !== (task !== undefined)) this.notify();
  }

  private fail(signal: AbortSignal, error: VoiceError): void {
    if (signal.aborted) return;
    this.binding?.onError(error);
    this.stop();
  }

  private setPhase(phase: VoicePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase !== 'transcribing' && phase !== 'thinking') {
      this.stopThinkingSound?.();
      this.stopThinkingSound = undefined;
    }
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const voiceSession = new VoiceSession();
