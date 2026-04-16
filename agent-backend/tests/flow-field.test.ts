import { describe, it, expect } from 'vitest';
import { computeFlowStates, computeFlowField } from '../src/flow-field';
import { EegTimeStep, FlowParams, DEFAULT_PARAMS } from '../src/types';
import { EegFlowState } from '../src/types';

describe('computeFlowStates', () => {
  it('computes activation from electrode samples', () => {
    const steps: EegTimeStep[] = [
      {
        index: 0,
        timestamp: 1000,
        electrodes: new Map([
          [0, [1000.0, 500.0]],
          [1, [800.0, 600.0]],
        ]),
      },
      {
        index: 1,
        timestamp: 2000,
        electrodes: new Map([
          [0, [1500.0, 300.0]],
          [1, [400.0, 900.0]],
        ]),
      },
    ];

    const result = computeFlowStates(steps, {
      electrodeLayout: [[-1, 0], [1, 0]],
    });

    expect(result).toHaveLength(2);
    expect(result[0].activation).toBeGreaterThan(0);
    expect(result[0].activation).toBeLessThan(1);
    const d0 = result[0].direction;
    const mag0 = Math.sqrt(d0.x * d0.x + d0.y * d0.y);
    expect(mag0).toBeCloseTo(1, 4);
  });

  it('normalizes activation to 0-1 range', () => {
    const steps: EegTimeStep[] = [
      {
        index: 0,
        timestamp: 1000,
        electrodes: new Map([[0, [100.0, 50.0]]]),
      },
      {
        index: 1,
        timestamp: 2000,
        electrodes: new Map([[0, [5000.0, 3000.0]]]),
      },
    ];

    const result = computeFlowStates(steps, {
      electrodeLayout: [[-1, 0]],
    });

    expect(Math.abs(result[0].activation - result[1].activation)).toBeLessThan(0.3);
  });
});

describe('computeFlowField', () => {
  it('maps time to polar coordinates', () => {
    const states: EegFlowState[] = [
      { index: 0, timestamp: 0, activation: 0.5, direction: { x: 1, y: 0 } },
      { index: 1, timestamp: 1, activation: 0.3, direction: { x: -1, y: 0 } },
      { index: 2, timestamp: 2, activation: 0.7, direction: { x: 0, y: 1 } },
    ];
    const audioFrames = [
      { energy: 0.2, bass: 0.1, mid: 0.1, treble: 0.1 },
      { energy: 0.5, bass: 0.2, mid: 0.2, treble: 0.1 },
      { energy: 0.8, bass: 0.3, mid: 0.3, treble: 0.2 },
    ];
    const params: FlowParams = {
      ...DEFAULT_PARAMS,
      rotations: 2,
    };

    const result = computeFlowField(states, audioFrames, params);
    expect(result).toHaveLength(3);
    // First theta should be (0/3) * 2 * 2 * PI = 0
    expect(result[0].theta).toBeCloseTo(0, 4);
    // Last theta should be (2/3) * 2 * 2 * PI = 8*PI/3
    expect(result[2].theta).toBeCloseTo(8 * Math.PI / 3, 4);
  });
});
