/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SpeechPlayer } from './speech_player';
import { pickVoice, ProviderSpeechPlayer } from './speech_player';

const flush = async () => {
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('ProviderSpeechPlayer', () => {
  let fallback: jest.Mocked<SpeechPlayer>;
  let synthesize: jest.Mock;
  let player: ProviderSpeechPlayer;
  let played: Array<{ text: string; finish: () => void; signal: AbortSignal }>;

  const playAudio = (audio: Blob, signal: AbortSignal) =>
    new Promise<void>(async (resolve, reject) => {
      try {
        played.push({
          text: await audio.text(),
          finish: resolve,
          signal,
        });
      } catch (error) {
        reject(error);
      }
    });

  beforeEach(() => {
    played = [];
    fallback = {
      speak: jest.fn((text: string, onEnd?: () => void) => onEnd?.()),
      isSpeaking: jest.fn(() => false),
      cancel: jest.fn(),
    };
    synthesize = jest.fn((text: string) => Promise.resolve(new Blob([text])));
    player = new ProviderSpeechPlayer({
      synthesize,
      playAudio,
      isEnabled: () => true,
      fallback,
    });
  });

  it('fetches every sentence up front and plays them in order', async () => {
    const onEnd = jest.fn();
    player.speak('One.');
    player.speak('Three.', onEnd);
    expect(synthesize).toHaveBeenCalledTimes(2);

    await flush();
    expect(played.map(({ text }) => text)).toEqual(['One.']);
    expect(player.isSpeaking()).toBe(true);

    played[0].finish();
    await flush();
    expect(played.map(({ text }) => text)).toEqual(['One.', 'Three.']);

    played[1].finish();
    await flush();
    expect(onEnd).toHaveBeenCalled();
    expect(player.isSpeaking()).toBe(false);
  });

  it('uses the browser voice when no provider is configured, and stops asking', async () => {
    synthesize.mockResolvedValue(undefined);
    const onEnd = jest.fn();
    player.speak('Hello.', onEnd);
    await flush();

    expect(fallback.speak).toHaveBeenCalledWith('Hello.', expect.any(Function));
    expect(onEnd).toHaveBeenCalled();

    player.speak('Again.');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(fallback.speak).toHaveBeenLastCalledWith('Again.', undefined);
  });

  it('speaks a sentence the provider failed on with the browser voice', async () => {
    synthesize.mockRejectedValueOnce(new Error('502'));
    player.speak('Hello.');
    await flush();

    expect(fallback.speak).toHaveBeenCalledWith('Hello.', expect.any(Function));
    player.speak('Next.');
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('stops playing and drops the queue when cancelled', async () => {
    const onEnd = jest.fn();
    player.speak('One.');
    player.speak('Two.', onEnd);
    await flush();
    player.cancel();
    await flush();

    expect(played[0].signal.aborted).toBe(true);
    expect(played).toHaveLength(1);
    expect(onEnd).not.toHaveBeenCalled();
    expect(player.isSpeaking()).toBe(false);
  });
});

describe('pickVoice', () => {
  const voice = (name: string, lang = 'en-US') => ({ name, lang } as SpeechSynthesisVoice);

  it('prefers the most natural voice for the page language', () => {
    const voices = [
      voice('Samantha'),
      voice('Google US English'),
      voice('Ava (Premium)'),
      voice('Amélie (Premium)', 'fr-CA'),
    ];

    expect(pickVoice(voices, 'en')?.name).toBe('Ava (Premium)');
    expect(pickVoice(voices, 'fr')?.name).toBe('Amélie (Premium)');
  });

  it('leaves the browser default when only compact voices are installed', () => {
    expect(pickVoice([voice('Samantha'), voice('Fred')], 'en')).toBeUndefined();
  });
});
