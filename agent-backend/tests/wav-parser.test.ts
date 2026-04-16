import { describe, it, expect } from 'vitest';
import { parseWavHeader, decodePcmData, computeAudioFrames } from '../src/wav-parser';

describe('computeAudioFrames', () => {
  it('splits samples into frames and computes energy', () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5, 0.0, 0.0]);
    const frameSize = 2;
    const frames = computeAudioFrames(samples, frameSize);
    expect(frames).toHaveLength(3);
    // First frame: [0.5, -0.5] -> RMS = sqrt((0.25 + 0.25)/2) = 0.5
    expect(frames[0].energy).toBeCloseTo(0.5, 2);
    // Third frame: [0.0, 0.0] -> RMS = 0
    expect(frames[2].energy).toBeCloseTo(0, 2);
  });

  it('handles remainder frames', () => {
    const samples = new Float32Array([1.0, 0.0, 0.5]);
    const frameSize = 2;
    const frames = computeAudioFrames(samples, frameSize);
    expect(frames).toHaveLength(2);
    expect(frames[1].energy).toBeCloseTo(0.5, 2); // [0.5] frame
  });

  it('computes frequency bands when frame is large enough', () => {
    const samples = new Float32Array(256);
    // Simple sine wave at ~5 cycles per frame
    for (let i = 0; i < 256; i++) {
      samples[i] = Math.sin(2 * Math.PI * 5 * i / 256);
    }
    const frames = computeAudioFrames(samples, 256);
    expect(frames).toHaveLength(1);
    expect(frames[0].bass + frames[0].mid + frames[0].treble).toBeGreaterThan(0);
  });
});
