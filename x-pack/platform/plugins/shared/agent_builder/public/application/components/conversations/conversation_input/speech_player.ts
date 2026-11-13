/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface SpeechPlayer {
  /** Queues text behind anything already playing, calling `onEnd` once it has been heard. */
  speak: (text: string, onEnd?: () => void) => void;
  isSpeaking: () => boolean;
  cancel: () => void;
}

/** Turns text into audio, or resolves without audio when no voice provider is configured. */
export type SynthesizeSpeech = (text: string, signal: AbortSignal) => Promise<Blob | undefined>;

// Most natural first. macOS lists premium and enhanced voices once the user downloads them, Edge
// names its neural voices "Natural", and Chrome's "Google" voices beat the compact system ones.
const NATURAL_VOICE_PATTERNS: readonly RegExp[] = [
  /premium/i,
  /enhanced/i,
  /natural|neural/i,
  /^google/i,
];

/** Picks the most natural installed voice for the page language, or the browser default. */
export const pickVoice = (
  voices: SpeechSynthesisVoice[],
  lang: string
): SpeechSynthesisVoice | undefined => {
  const [language] = lang.toLowerCase().split('-');
  const candidates = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
  for (const pattern of NATURAL_VOICE_PATTERNS) {
    const matches = candidates.filter(({ name }) => pattern.test(name));
    const match =
      matches.find((voice) => voice.lang.toLowerCase() === lang.toLowerCase()) ?? matches[0];
    if (match) return match;
  }
  return undefined;
};

/** Speaks with the browser's own voices. */
export const createBrowserSpeechPlayer = (): SpeechPlayer => ({
  speak: (text, onEnd) => {
    const { lang } = document.documentElement;
    const voice = pickVoice(window.speechSynthesis.getVoices(), lang);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice?.lang ?? lang;
    if (voice) utterance.voice = voice;
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.speak(utterance);
  },
  isSpeaking: () => Boolean(window.speechSynthesis?.speaking || window.speechSynthesis?.pending),
  cancel: () => window.speechSynthesis?.cancel(),
});

type SpeechAudio = Blob | 'unavailable' | 'failed';

interface QueuedSpeech {
  text: string;
  audio: Promise<SpeechAudio>;
  onEnd?: () => void;
}

/** Plays audio to the end, or until the signal aborts. */
export type PlayAudio = (audio: Blob, signal: AbortSignal) => Promise<void>;

const playWithAudioElement: PlayAudio = (audio, signal) =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(audio);
    const element = new Audio(url);
    const done = () => {
      signal.removeEventListener('abort', stop);
      URL.revokeObjectURL(url);
      resolve();
    };
    const stop = () => {
      element.pause();
      done();
    };
    element.onended = done;
    element.onerror = done;
    signal.addEventListener('abort', stop);
    element.play().catch(done);
  });

interface ProviderSpeechPlayerOptions {
  synthesize: SynthesizeSpeech;
  playAudio?: PlayAudio;
  /** Whether a provider may be asked at all; otherwise the fallback speaks straight away. */
  isEnabled: () => boolean;
  fallback: SpeechPlayer;
}

/**
 * Speaks with a voice provider. Every queued sentence is fetched as soon as it is queued so the
 * next one is ready when the current one ends; a sentence that fails is spoken by the fallback.
 */
export class ProviderSpeechPlayer implements SpeechPlayer {
  private queue: QueuedSpeech[] = [];
  private controller = new AbortController();
  private playing = false;
  private unavailable = false;

  constructor(private readonly options: ProviderSpeechPlayerOptions) {}

  speak(text: string, onEnd?: () => void): void {
    if (this.unavailable || !this.options.isEnabled()) {
      this.options.fallback.speak(text, onEnd);
      return;
    }
    const audio = this.options
      .synthesize(text, this.controller.signal)
      .then((blob): SpeechAudio => blob ?? 'unavailable')
      .catch((): SpeechAudio => 'failed');
    this.queue.push({ text, audio, onEnd });
    if (!this.playing) void this.playQueue(this.controller.signal);
  }

  isSpeaking(): boolean {
    return this.playing || this.options.fallback.isSpeaking();
  }

  cancel(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.queue = [];
    this.playing = false;
    this.options.fallback.cancel();
  }

  private async playQueue(signal: AbortSignal): Promise<void> {
    this.playing = true;
    let next = this.queue.shift();
    while (next && !signal.aborted) {
      const { text, audio, onEnd } = next;
      const result = await audio;
      if (signal.aborted) return;
      if (result === 'unavailable') this.unavailable = true;
      if (result instanceof Blob) {
        await (this.options.playAudio ?? playWithAudioElement)(result, signal);
      } else {
        await new Promise<void>((resolve) => this.options.fallback.speak(text, resolve));
      }
      if (signal.aborted) return;
      onEnd?.();
      next = this.queue.shift();
    }
    this.playing = false;
  }
}
