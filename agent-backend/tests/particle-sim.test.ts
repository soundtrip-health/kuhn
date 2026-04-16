import { describe, it, expect } from 'vitest';
import { simulateParticles, FlowFieldPoint } from '../src/particle-sim';
import { FlowParams, DEFAULT_PARAMS } from '../src/types';

describe('simulateParticles', () => {
  const mockField: FlowFieldPoint[] = [
    { theta: 0, r: 100, energy: 0.5, spectrum: { bass: 0.3, mid: 0.3, treble: 0.4 } },
    { theta: Math.PI / 4, r: 120, energy: 0.7, spectrum: { bass: 0.4, mid: 0.3, treble: 0.3 } },
    { theta: Math.PI / 2, r: 110, energy: 0.3, spectrum: { bass: 0.2, mid: 0.3, treble: 0.5 } },
    { theta: 3 * Math.PI / 4, r: 130, energy: 0.9, spectrum: { bass: 0.5, mid: 0.2, treble: 0.3 } },
  ];

  const params: FlowParams = {
    ...DEFAULT_PARAMS,
    particleCount: 3,
  };

  it('produces one path per particle', () => {
    const result = simulateParticles(mockField, params, 3);
    expect(result.paths).toHaveLength(3);
    expect(result.paths[0]).toHaveLength(4);
  });

  it('converts polar to Cartesian coordinates', () => {
    const result = simulateParticles(mockField, params, 1);
    const firstPoint = result.paths[0][0];
    const fieldPoint = mockField[0];
    const expectedX = Math.cos(fieldPoint.theta) * fieldPoint.r;
    const expectedY = Math.sin(fieldPoint.theta) * fieldPoint.r;
    expect(firstPoint.x).toBeCloseTo(expectedX, 1);
    expect(firstPoint.y).toBeCloseTo(expectedY, 1);
  });

  it('includes spectrum data in path points', () => {
    const result = simulateParticles(mockField, params, 1);
    expect(result.paths[0][0].spectrum.bass).toBe(0.3);
    expect(result.paths[0][1].spectrum.mid).toBe(0.3);
  });
});
