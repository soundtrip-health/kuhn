import { AudioFrame } from './types';

export function parseWavHeader(buffer: Buffer): { sampleRate: number; channelCount: number; dataOffset: number; bitDepth: number } {
  const riff = buffer.subarray(0, 4).toString('ascii');
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file: missing RIFF header');
  }

  const wav = buffer.subarray(8, 12).toString('ascii');
  if (wav !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE format');
  }

  let offset = 12;
  let sampleRate = 44100;
  let bitDepth = 16;
  let channelCount = 1;
  let dataOffset = 0;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      sampleRate = buffer.readUInt32LE(offset + 8);
      bitDepth = buffer.readUInt16LE(offset + 22);
      channelCount = buffer.readUInt16LE(offset + 20);
    }

    if (chunkId === 'data') {
      dataOffset = offset + 8;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === 0) {
    throw new Error('Not a valid WAV file: missing data chunk');
  }

  return { sampleRate, channelCount, dataOffset, bitDepth };
}

export function decodePcmData(buffer: Buffer, dataOffset: number, bitDepth: number): Float32Array {
  const dataLength = buffer.length - dataOffset;
  const sampleCount = Math.floor(dataLength / (bitDepth / 8));
  const samples = new Float32Array(sampleCount);

  switch (bitDepth) {
    case 16:
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
      }
      break;
    case 8:
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = (buffer.readUInt8(dataOffset + i) - 128) / 128;
      }
      break;
    default:
      throw new Error(`Unsupported bit depth: ${bitDepth}`);
  }

  return samples;
}

export function computeAudioFrames(samples: Float32Array, frameSize: number): AudioFrame[] {
  const frames: AudioFrame[] = [];
  const numFrames = Math.ceil(samples.length / frameSize);

  for (let i = 0; i < numFrames; i++) {
    const start = i * frameSize;
    const end = Math.min(start + frameSize, samples.length);
    const frame = samples.slice(start, end);

    // RMS energy
    let sumSq = 0;
    for (let j = 0; j < frame.length; j++) {
      sumSq += frame[j] * frame[j];
    }
    const energy = Math.sqrt(sumSq / frame.length);

    // Simple frequency band separation using windowed DFT
    let bass = 0, mid = 0, treble = 0;
    if (frame.length >= 32) {
      const n = frame.length;
      const magnitudes = new Float32Array(n / 2);
      for (let k = 1; k < n / 2; k++) {
        let re = 0, im = 0;
        for (let t = 0; t < n; t++) {
          const angle = -2 * Math.PI * k * t / n;
          re += frame[t] * Math.cos(angle);
          im += frame[t] * Math.sin(angle);
        }
        magnitudes[k] = Math.sqrt(re * re + im * im) / n;
      }

      const bandWidth = n / 2;
      const bassEnd = Math.floor(bandWidth * 0.15);
      const midEnd = Math.floor(bandWidth * 0.5);
      const trebleStart = midEnd;

      for (let k = 1; k <= bassEnd; k++) bass += magnitudes[k];
      for (let k = bassEnd + 1; k <= midEnd; k++) mid += magnitudes[k];
      for (let k = trebleStart + 1; k < bandWidth; k++) treble += magnitudes[k];
    }

    frames.push({ energy: Math.min(energy, 1), bass, mid, treble });
  }

  return frames;
}
