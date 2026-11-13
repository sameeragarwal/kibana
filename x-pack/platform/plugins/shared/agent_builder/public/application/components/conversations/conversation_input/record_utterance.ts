/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

const TRANSCRIPTION_SAMPLE_RATE = 16_000;
// Root mean square level of the waveform above which the user is treated as speaking.
const SPEECH_LEVEL = 0.02;
const END_OF_SPEECH_SILENCE_MS = 1200;
const NO_SPEECH_TIMEOUT_MS = 8000;
// Keeps a recording within what the transcription route accepts.
const MAX_UTTERANCE_MS = 55_000;
const LEVEL_POLL_MS = 50;

/** An open microphone, kept for the whole voice conversation so the browser asks only once. */
export interface Microphone {
  stream: MediaStream;
  analyser: AnalyserNode;
  release: () => void;
}

export const openMicrophone = async (): Promise<Microphone> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(stream).connect(analyser);
  return {
    stream,
    analyser,
    release: () => {
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
};

const getLevel = (analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number => {
  analyser.getFloatTimeDomainData(samples);
  const energy = samples.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(energy / samples.length);
};

/**
 * Records one thing the user says, ending after a pause. Resolves `undefined` when the user
 * stays silent or the recording is aborted.
 */
export const recordUtterance = (
  { stream, analyser }: Microphone,
  signal: AbortSignal
): Promise<Blob | undefined> =>
  new Promise((resolve) => {
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = Date.now();
    let speechStartedAt: number | undefined;
    let lastSpeechAt = startedAt;
    let keep = false;

    const finish = (keepRecording: boolean) => {
      clearInterval(pollId);
      signal.removeEventListener('abort', onAbort);
      keep = keepRecording;
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const onAbort = () => finish(false);

    recorder.ondataavailable = ({ data }) => chunks.push(data);
    recorder.onstop = () =>
      resolve(keep ? new Blob(chunks, { type: recorder.mimeType }) : undefined);

    const pollId = setInterval(() => {
      const now = Date.now();
      if (getLevel(analyser, samples) > SPEECH_LEVEL) {
        speechStartedAt ??= now;
        lastSpeechAt = now;
      }
      if (speechStartedAt === undefined) {
        if (now - startedAt > NO_SPEECH_TIMEOUT_MS) finish(false);
      } else if (
        now - lastSpeechAt > END_OF_SPEECH_SILENCE_MS ||
        now - startedAt > MAX_UTTERANCE_MS
      ) {
        finish(true);
      }
    }, LEVEL_POLL_MS);

    signal.addEventListener('abort', onAbort);
    recorder.start();
  });

/** Encodes mono samples as a 16-bit PCM WAV file. */
export const encodeWav = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) =>
    [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      44 + index * bytesPerSample,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true
    );
  });
  return buffer;
};

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

/** Converts a browser recording to base64 16 kHz mono WAV, a format every speech model accepts. */
export const toTranscriptionAudio = async (recording: Blob): Promise<string> => {
  // Decoding through a 16 kHz context resamples the recording as it decodes.
  const decoded = await new OfflineAudioContext(1, 1, TRANSCRIPTION_SAMPLE_RATE).decodeAudioData(
    await recording.arrayBuffer()
  );
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
    decoded.getChannelData(index)
  );
  const mono = new Float32Array(decoded.length).map(
    (_, index) => channels.reduce((sum, channel) => sum + channel[index], 0) / channels.length
  );
  return toBase64(encodeWav(mono, decoded.sampleRate));
};
