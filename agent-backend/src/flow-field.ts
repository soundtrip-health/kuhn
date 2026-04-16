import { EegTimeStep, EegFlowState, FlowParams } from './types';

export interface FlowConfig {
  electrodeLayout: [number, number][];
  maxActivation?: number;
}

const DEFAULT_CONFIG: FlowConfig = {
  electrodeLayout: [],
  maxActivation: 2000,
};

function computeSampleActivation(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sumSq = samples.reduce((sum, v) => sum + v * v, 0);
  return Math.sqrt(sumSq / samples.length);
}

function normalizeActivation(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  const r = value / max;
  const p = Math.pow(r, 0.3);
  return p / (1 + p);
}

export function computeFlowStates(
  steps: EegTimeStep[],
  config: FlowConfig = DEFAULT_CONFIG
): EegFlowState[] {
  const { electrodeLayout, maxActivation = 2000 } = config;
  const states: EegFlowState[] = [];

  for (const step of steps) {
    let totalActivation = 0;
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;

    for (const [electrodeId, samples] of step.electrodes) {
      const activation = computeSampleActivation(samples);
      totalActivation += activation;

      const layout = electrodeLayout[electrodeId] || [0, 0];
      const [lx, ly] = layout;

      weightedX += activation * lx;
      weightedY += activation * ly;
      totalWeight += activation;
    }

    const avgActivation = step.electrodes.size > 0 ? totalActivation / step.electrodes.size : 0;
    const normalizedActivation = normalizeActivation(avgActivation, maxActivation);

    let dirX = 0, dirY = 0;
    if (totalWeight > 0) {
      dirX = weightedX / totalWeight;
      dirY = weightedY / totalWeight;
      const mag = Math.sqrt(dirX * dirX + dirY * dirY);
      if (mag > 0) {
        dirX /= mag;
        dirY /= mag;
      }
    }

    states.push({
      index: step.index,
      timestamp: step.timestamp,
      activation: normalizedActivation,
      direction: { x: dirX, y: dirY },
    });
  }

  return states;
}

export function computeFlowField(
  flowStates: EegFlowState[],
  audioFrames: { energy: number; bass: number; mid: number; treble: number }[],
  params: FlowParams
): { theta: number; r: number; energy: number; spectrum: { bass: number; mid: number; treble: number } }[] {
  const field: { theta: number; r: number; energy: number; spectrum: { bass: number; mid: number; treble: number } }[] = [];
  const n = flowStates.length;

  for (let i = 0; i < n; i++) {
    const state = flowStates[i];
    const audio = audioFrames[i] || { energy: 0, bass: 0, mid: 0, treble: 0 };

    const theta = (i / n) * params.rotations * 2 * Math.PI;
    const eegRadiusMod = state.activation * params.flowScale;
    const audioRadiusMod = audio.energy * params.audioIntensity * params.flowScale * 0.5;
    const r = params.baseRadius + eegRadiusMod + audioRadiusMod;

    field.push({
      theta,
      r,
      energy: audio.energy,
      spectrum: { bass: audio.bass, mid: audio.mid, treble: audio.treble },
    });
  }

  return field;
}
