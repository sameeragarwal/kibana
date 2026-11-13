/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { openMicrophone, recordUtterance, toTranscriptionAudio } from './record_utterance';
import type {
  VoiceConverseRequestBody,
  VoiceConverseResponse,
} from '../../../../../common/http_api/voice';
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
  for (let tick = 0; tick < 8; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

class FakeUtterance {
  onend: (() => void) | null = null;
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  constructor(public readonly text: string) {}
}

interface Listen {
  signal: AbortSignal;
  startTalking: () => void;
  /** Ends the recording with speech, or with silence when `heard` is false. */
  finish: (heard?: boolean) => void;
}

describe('VoiceSession', () => {
  const releaseMicrophone = jest.fn();
  const spoken: FakeUtterance[] = [];
  const spokenTexts = () => spoken.map(({ text }) => text);
  const finishSpeaking = () => spoken.forEach((utterance) => utterance.onend?.());
  const listens: Listen[] = [];
  const currentListen = () => listens[listens.length - 1];
  let binding: jest.Mocked<VoiceSessionBinding>;
  let session: VoiceSession;

  /** Has the user say `text` in the current listen. */
  const userSays = async (text: string) => {
    binding.transcribe.mockResolvedValueOnce(text);
    currentListen().finish();
    await flush();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    spoken.length = 0;
    listens.length = 0;
    mockedOpenMicrophone.mockResolvedValue({ release: releaseMicrophone } as never);
    mockedRecordUtterance.mockImplementation(
      (_microphone, signal, onSpeechStart) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(undefined));
          listens.push({
            signal,
            startTalking: () => onSpeechStart?.(),
            finish: (heard = true) => resolve(heard ? new Blob(['audio']) : undefined),
          });
        })
    );
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
      transcribe: jest.fn(),
      send: jest.fn().mockReturnValue(true),
      onError: jest.fn(),
    };
    session = new VoiceSession();
    session.bind(binding);
  });

  afterEach(() => {
    session.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('without a voice agent', () => {
    it('hands what the user said to the agent and keeps listening while it works', async () => {
      session.start();
      await flush();
      await userSays('Which services are failing?');

      expect(binding.transcribe).toHaveBeenCalledWith('d2F2', expect.any(AbortSignal));
      expect(binding.send).toHaveBeenCalledWith('Which services are failing?');
      expect(session.isAwaitingAgent()).toBe(true);
      expect(session.getPhase()).toBe('listening');
      expect(mockedOpenMicrophone).toHaveBeenCalledTimes(1);
    });

    it('reads the answer once, then listens again', async () => {
      session.start();
      await flush();
      await userSays('Which services are failing?');

      session.agentAnswered('round-1', {
        markdown: '**Checkout** is failing.',
        text: 'Checkout is failing. Payments look fine.',
      });
      session.agentAnswered('round-1', { markdown: 'again', text: 'Again.' });
      await flush();

      expect(session.isAwaitingAgent()).toBe(false);
      expect(session.getPhase()).toBe('speaking');
      expect(spokenTexts()).toEqual(['Checkout is failing.', 'Payments look fine.']);

      finishSpeaking();
      await flush();
      expect(session.getPhase()).toBe('listening');
    });

    it('reads the newest activity during a quiet moment', async () => {
      jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
      session.start();
      await flush();
      await userSays('Which services are failing?');
      session.addActivity('Checking the error logs.');

      jest.advanceTimersByTime(5000);
      await flush();
      expect(spokenTexts()).toEqual(['Checking the error logs.']);
    });
  });

  describe('with a voice agent', () => {
    let converse: jest.Mock<
      Promise<VoiceConverseResponse>,
      [VoiceConverseRequestBody, AbortSignal]
    >;

    beforeEach(() => {
      converse = jest.fn<Promise<VoiceConverseResponse>, [VoiceConverseRequestBody, AbortSignal]>();
      binding.converse = converse;
    });

    it('answers small talk itself', async () => {
      converse.mockResolvedValue({ say: 'Doing well, thanks.' });
      session.start();
      await flush();
      await userSays('How are you?');

      expect(converse).toHaveBeenCalledWith(
        {
          trigger: 'user',
          transcript: [{ speaker: 'user', text: 'How are you?' }],
          agent: { status: 'idle' },
        },
        expect.any(AbortSignal)
      );
      expect(binding.send).not.toHaveBeenCalled();
      expect(spokenTexts()).toEqual(['Doing well, thanks.']);
    });

    it('hands a request to the agent and talks about its progress while listening', async () => {
      jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
      converse.mockResolvedValueOnce({
        say: "I'll check.",
        askAgent: 'List services with errors in the last 15 minutes',
      });
      session.start();
      await flush();
      await userSays('Which services are failing?');

      expect(binding.send).toHaveBeenCalledWith('List services with errors in the last 15 minutes');
      expect(session.isAwaitingAgent()).toBe(true);
      finishSpeaking();
      await flush();
      expect(session.getPhase()).toBe('listening');

      converse.mockResolvedValueOnce({ say: "It's counting failed requests per service." });
      session.addActivity('Count failed transactions per service.');
      jest.advanceTimersByTime(2000);
      await flush();
      expect(converse).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(3000);
      await flush();
      expect(converse).toHaveBeenLastCalledWith(
        expect.objectContaining({
          trigger: 'progress',
          agent: {
            status: 'working',
            task: 'List services with errors in the last 15 minutes',
            activity: ['Count failed transactions per service.'],
          },
        }),
        expect.any(AbortSignal)
      );
      expect(spokenTexts()).toContain("It's counting failed requests per service.");
    });

    it('does not talk over the user', async () => {
      jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
      converse.mockResolvedValueOnce({ say: '', askAgent: 'Find failing services' });
      session.start();
      await flush();
      await userSays('Which services are failing?');

      currentListen().startTalking();
      session.addActivity('Count failed transactions per service.');
      jest.advanceTimersByTime(10_000);
      await flush();

      expect(converse).toHaveBeenCalledTimes(1);
      expect(currentListen().signal.aborted).toBe(false);
    });

    it('retells the answer in its own words', async () => {
      converse.mockResolvedValueOnce({ say: '', askAgent: 'Find failing services' });
      session.start();
      await flush();
      await userSays('Which services are failing?');

      converse.mockResolvedValueOnce({ say: 'Only checkout is failing, mostly timeouts.' });
      session.agentAnswered('round-1', {
        markdown: '| Service | Failed |\n|---|---|\n| checkout | 412 |',
        text: 'Service, Failed. checkout, 412.',
      });
      await flush();

      expect(converse).toHaveBeenLastCalledWith(
        expect.objectContaining({
          trigger: 'answer',
          agent: { status: 'idle' },
          answer: '| Service | Failed |\n|---|---|\n| checkout | 412 |',
        }),
        expect.any(AbortSignal)
      );
      expect(spokenTexts()).toEqual(['Only checkout is failing, mostly timeouts.']);
    });

    it('reads the answer when the voice agent fails', async () => {
      converse.mockResolvedValueOnce({ say: '', askAgent: 'Find failing services' });
      session.start();
      await flush();
      await userSays('Which services are failing?');

      converse.mockRejectedValueOnce(new Error('model unavailable'));
      session.agentAnswered('round-1', { markdown: '**Checkout**', text: 'Checkout is failing.' });
      await flush();

      expect(spokenTexts()).toEqual(['Checkout is failing.']);
    });

    it('sends a request made while the agent is busy once it is done', async () => {
      jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
      converse
        .mockResolvedValueOnce({ say: '', askAgent: 'Find failing services' })
        .mockResolvedValueOnce({ say: "I'll ask after this.", askAgent: 'Check host memory' });
      session.start();
      await flush();
      await userSays('Which services are failing?');
      await userSays('And how is memory on the hosts?');
      finishSpeaking();
      await flush();
      expect(binding.send).toHaveBeenCalledTimes(1);

      converse.mockResolvedValueOnce({ say: '' });
      session.agentAnswered('round-1', { markdown: 'Checkout', text: 'Checkout.' });
      await flush();
      jest.advanceTimersByTime(1000);
      await flush();

      expect(binding.send).toHaveBeenLastCalledWith('Check host memory');
      expect(session.isAwaitingAgent()).toBe(true);
    });
  });

  it('reads out what the agent needs confirmed, then ends the call', async () => {
    session.start();
    await flush();
    await userSays('Restart checkout');

    session.agentPrompted('round-1', 'The agent needs your confirmation.');
    await flush();
    expect(spokenTexts()).toEqual(['The agent needs your confirmation.']);

    finishSpeaking();
    await flush();
    expect(session.getPhase()).toBe('idle');
    expect(releaseMicrophone).toHaveBeenCalled();
  });

  it('ignores rounds already on screen', async () => {
    session.start();
    await flush();
    await userSays('Which services are failing?');
    session.markHandled(['round-0']);

    expect(session.isAwaitedReply('round-0')).toBe(false);
    expect(session.isAwaitedReply('round-1')).toBe(true);
  });

  it('ends quietly when the user says nothing and nothing is pending', async () => {
    session.start();
    await flush();
    currentListen().finish(false);
    await flush();

    expect(binding.send).not.toHaveBeenCalled();
    expect(session.getPhase()).toBe('idle');
    expect(releaseMicrophone).toHaveBeenCalled();
  });

  it('keeps listening through silence while the agent works', async () => {
    session.start();
    await flush();
    await userSays('Which services are failing?');
    currentListen().finish(false);
    await flush();

    expect(session.getPhase()).toBe('listening');
    expect(listens).toHaveLength(3);
  });

  it('stops waiting on an agent run that ended without an answer', async () => {
    session.start();
    await flush();
    await userSays('Which services are failing?');
    session.agentFailed();

    expect(session.isAwaitingAgent()).toBe(false);
  });

  it('reports a blocked microphone', async () => {
    mockedOpenMicrophone.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    session.start();
    await flush();

    expect(binding.onError).toHaveBeenCalledWith({ code: 'not-allowed' });
    expect(session.getPhase()).toBe('idle');
  });

  it('reports why transcription failed', async () => {
    session.start();
    await flush();
    binding.transcribe.mockRejectedValue({ body: { message: 'No speech model' } });
    currentListen().finish();
    await flush();

    expect(binding.onError).toHaveBeenCalledWith({
      code: 'transcription-failed',
      reason: 'No speech model',
    });
    expect(session.getPhase()).toBe('idle');
  });

  it('drops the recording when stopped mid-listen', async () => {
    session.start();
    await flush();
    session.stop();
    await flush();

    expect(currentListen().signal.aborted).toBe(true);
    expect(binding.transcribe).not.toHaveBeenCalled();
    expect(releaseMicrophone).toHaveBeenCalled();
  });
});
