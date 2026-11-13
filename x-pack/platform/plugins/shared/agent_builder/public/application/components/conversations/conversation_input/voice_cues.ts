/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

interface Tone {
  frequency: number;
  startSeconds: number;
  durationSeconds: number;
}

/** How long the listening cue plays; recording starts after it so the cue isn't heard as speech. */
export const LISTENING_CUE_MS = 320;

const THINKING_PULSE_MS = 2400;

let audioContext: AudioContext | undefined;

const getAudioContext = (): AudioContext | undefined => {
  if (typeof AudioContext === 'undefined') return undefined;
  audioContext ??= new AudioContext();
  if (audioContext.state === 'suspended') void audioContext.resume();
  return audioContext;
};

const playTones = (tones: readonly Tone[], volume: number): void => {
  const context = getAudioContext();
  if (!context) return;
  tones.forEach(({ frequency, startSeconds, durationSeconds }) => {
    const start = context.currentTime + startSeconds;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + durationSeconds);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + durationSeconds);
  });
};

/** Rising chime: the microphone is open. */
export const playListeningCue = (): void =>
  playTones(
    [
      { frequency: 523.25, startSeconds: 0, durationSeconds: 0.14 },
      { frequency: 783.99, startSeconds: 0.1, durationSeconds: 0.2 },
    ],
    0.12
  );

/** Falling chime: the user's words were captured. */
export const playHeardCue = (): void =>
  playTones(
    [
      { frequency: 783.99, startSeconds: 0, durationSeconds: 0.14 },
      { frequency: 587.33, startSeconds: 0.1, durationSeconds: 0.2 },
    ],
    0.1
  );

/** Plays a soft pulse while the agent works, pausing whenever something is being spoken. */
export const startThinkingSound = (isSpeaking: () => boolean): (() => void) => {
  const pulse = () => {
    if (isSpeaking()) return;
    playTones(
      [
        { frequency: 440, startSeconds: 0, durationSeconds: 0.7 },
        { frequency: 659.25, startSeconds: 0.35, durationSeconds: 0.8 },
      ],
      0.035
    );
  };
  pulse();
  const intervalId = setInterval(pulse, THINKING_PULSE_MS);
  return () => clearInterval(intervalId);
};
