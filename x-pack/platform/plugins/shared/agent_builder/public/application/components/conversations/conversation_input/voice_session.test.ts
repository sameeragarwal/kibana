/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { openMicrophone, recordUtterance, toTranscriptionAudio } from './record_utterance';
import type { NarrateRequestBody } from '../../../../../common/http_api/voice';
import type { VoiceSessionBinding } from './voice_session';
import { VoiceSession } from './voice_session';

jest.mock('./voice_cues', () => ({
  LISTENING_CUE_MS: 0,
  playHeardCue: jest.fn(),
  playListeningCue: jest.fn(),
  startThinkingSound: jest.fn(() => jest.fn()),
}));

jest.mock('./record_utterance', () => ({
  openMicrophone: jest.fn(),
  recordUtterance: jest.fn(),
  toTranscriptionAudio: jest.fn(),
}));

const mockedOpenMicrophone = jest.mocked(openMicrophone);
const mockedRecordUtterance = jest.mocked(recordUtterance);
const mockedToTranscriptionAudio = jest.mocked(toTranscriptionAudio);

const flush = async () => {
  for (let tick = 0; tick < 5; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

class FakeUtterance {
  onend: (() => void) | null = null;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  constructor(public readonly text: string) {}
}

describe('VoiceSession', () => {
  const releaseMicrophone = jest.fn();
  const spoken: FakeUtterance[] = [];
  const spokenTexts = () => spoken.map(({ text }) => text);
  let binding: jest.Mocked<VoiceSessionBinding>;
  let session: VoiceSession;

  beforeEach(() => {
    jest.clearAllMocks();
    spoken.length = 0;
    mockedOpenMicrophone.mockResolvedValue({ release: releaseMicrophone } as never);
    mockedRecordUtterance.mockResolvedValue(new Blob(['audio']));
    mockedToTranscriptionAudio.mockResolvedValue('d2F2');
    Object.assign(window, {
      SpeechSynthesisUtterance: FakeUtterance,
      speechSynthesis: {
        cancel: jest.fn(),
        getVoices: () => [],
        speak: (utterance: FakeUtterance) => spoken.push(utterance),
      },
    });
    binding = {
      transcribe: jest.fn().mockResolvedValue('Which services are failing?'),
      send: jest.fn().mockReturnValue(true),
      onError: jest.fn(),
    };
    session = new VoiceSession();
    session.bind(binding);
  });

  afterEach(() => {
    session.stop();
    jest.restoreAllMocks();
  });

  it('sends what the user said, speaks the reply, then listens again', async () => {
    session.start();
    await flush();

    expect(binding.transcribe).toHaveBeenCalledWith('d2F2', expect.any(AbortSignal));
    expect(binding.send).toHaveBeenCalledWith('Which services are failing?');
    expect(session.getPhase()).toBe('thinking');
    expect(spoken).toHaveLength(0);

    mockedRecordUtterance.mockReturnValue(new Promise(() => {}));
    session.speakReply(
      'round-1',
      { text: 'Checkout is failing. Payments look fine.' },
      { thenListen: true }
    );
    expect(session.getPhase()).toBe('speaking');
    expect(spokenTexts()).toEqual(['Checkout is failing.', 'Payments look fine.']);

    spoken.at(-1)?.onend?.();
    await flush();
    expect(session.getPhase()).toBe('listening');
    expect(mockedOpenMicrophone).toHaveBeenCalledTimes(1);
  });

  it('speaks each reply only once', async () => {
    session.start();
    await flush();
    session.speakReply('round-1', { text: 'Done.' }, { thenListen: false });
    spoken.at(-1)?.onend?.();
    session.speakReply('round-1', { text: 'Done.' }, { thenListen: false });

    expect(spokenTexts().filter((text) => text === 'Done.')).toHaveLength(1);
    expect(session.getPhase()).toBe('idle');
  });

  it('does not read out a reply that finished while the microphone was off', async () => {
    session.start();
    await flush();
    session.stop();
    session.markHandled(['round-1']);

    session.start();
    await flush();
    session.speakReply('round-1', { text: 'Old reply.' }, { thenListen: true });
    expect(spokenTexts()).not.toContain('Old reply.');
    expect(session.getPhase()).toBe('thinking');

    session.speakReply('round-2', { text: 'New reply.' }, { thenListen: false });
    expect(spokenTexts().at(-1)).toBe('New reply.');
  });

  it('reads the newest activity aloud when no voice model is available', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
    session.addActivity('Ignored before the user speaks.');
    session.start();
    await flush();

    session.addActivity('Checking your logs.');
    session.addActivity('Counting documents.');
    jest.advanceTimersByTime(3000);
    expect(spokenTexts()).toEqual([]);

    jest.advanceTimersByTime(2000);
    await flush();
    expect(spokenTexts()).toEqual(['Counting documents.']);

    jest.advanceTimersByTime(10_000);
    await flush();
    expect(spokenTexts()).toEqual(['Counting documents.']);
    jest.useRealTimers();
  });

  describe('with a voice model', () => {
    let narrate: jest.Mock<Promise<string>, [NarrateRequestBody, AbortSignal]>;

    beforeEach(() => {
      narrate = jest.fn<Promise<string>, [NarrateRequestBody, AbortSignal]>(async ({ kind }) =>
        kind === 'start'
          ? 'Sure, let me look at your services.'
          : kind === 'progress'
          ? 'I am counting failed requests now.'
          : 'Checkout is failing. The details are on screen.'
      );
      binding.narrate = narrate;
    });

    it('talks about the work as it happens, in its own words', async () => {
      jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
      session.start();
      await flush();
      expect(narrate).toHaveBeenCalledWith(
        { kind: 'start', question: 'Which services are failing?' },
        expect.any(AbortSignal)
      );
      expect(spokenTexts()).toEqual(['Sure, let me look at your services.']);

      session.addActivity('Count failed transactions per service.');
      jest.advanceTimersByTime(5000);
      await flush();
      expect(narrate).toHaveBeenLastCalledWith(
        {
          kind: 'progress',
          question: 'Which services are failing?',
          activity: ['Count failed transactions per service.'],
          said: ['Sure, let me look at your services.'],
        },
        expect.any(AbortSignal)
      );
      expect(spokenTexts().at(-1)).toBe('I am counting failed requests now.');

      jest.advanceTimersByTime(10_000);
      await flush();
      expect(narrate).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it('retells the written answer instead of reading it', async () => {
      session.start();
      await flush();
      session.speakReply(
        'round-1',
        { markdown: '| service | errors |\n| checkout | 42 |', text: 'Raw answer.' },
        { thenListen: false }
      );
      await flush();

      expect(narrate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'answer',
          answer: '| service | errors |\n| checkout | 42 |',
        }),
        expect.any(AbortSignal)
      );
      expect(spokenTexts().slice(-2)).toEqual([
        'Checkout is failing.',
        'The details are on screen.',
      ]);
    });

    it('falls back to the written answer when the voice model fails', async () => {
      session.start();
      await flush();
      narrate.mockRejectedValueOnce(new Error('502'));
      session.speakReply(
        'round-1',
        { markdown: 'Answer', text: 'Raw answer.' },
        { thenListen: false }
      );
      await flush();

      expect(spokenTexts().at(-1)).toBe('Raw answer.');
    });
  });

  it('ends quietly when the user says nothing', async () => {
    mockedRecordUtterance.mockResolvedValue(undefined);

    session.start();
    await flush();

    expect(binding.transcribe).not.toHaveBeenCalled();
    expect(binding.onError).not.toHaveBeenCalled();
    expect(session.getPhase()).toBe('idle');
    expect(releaseMicrophone).toHaveBeenCalled();
  });

  it('ends when the message cannot be sent', async () => {
    binding.send.mockReturnValue(false);

    session.start();
    await flush();

    expect(session.getPhase()).toBe('idle');
  });

  it('reports a blocked microphone', async () => {
    mockedOpenMicrophone.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    session.start();
    await flush();

    expect(binding.onError).toHaveBeenCalledWith({ code: 'not-allowed' });
    expect(session.getPhase()).toBe('idle');
  });

  it('reports why transcription failed', async () => {
    binding.transcribe.mockRejectedValue({ body: { message: 'No model available' } });

    session.start();
    await flush();

    expect(binding.onError).toHaveBeenCalledWith({
      code: 'transcription-failed',
      reason: 'No model available',
    });
    expect(session.getPhase()).toBe('idle');
  });

  it('drops the recording when stopped mid-turn', async () => {
    let finishRecording: (recording: Blob) => void = () => {};
    mockedRecordUtterance.mockReturnValue(
      new Promise((resolve) => {
        finishRecording = resolve;
      })
    );

    session.start();
    await flush();
    session.stop();
    finishRecording(new Blob(['audio']));
    await flush();

    expect(binding.transcribe).not.toHaveBeenCalled();
    expect(session.getPhase()).toBe('idle');
    expect(releaseMicrophone).toHaveBeenCalled();
  });
});
