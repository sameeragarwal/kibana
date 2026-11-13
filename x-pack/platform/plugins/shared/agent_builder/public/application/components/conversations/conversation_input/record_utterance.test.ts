/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { encodeWav } from './record_utterance';

const readText = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));

describe('encodeWav', () => {
  it('writes 16-bit mono PCM that speech models can read', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 16_000));

    expect(readText(view, 0, 4)).toBe('RIFF');
    expect(readText(view, 8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
