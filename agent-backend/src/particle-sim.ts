import { NeuralFlowResult, PathPoint, FlowParams, DEFAULT_PARAMS } from './types';

export interface FlowFieldPoint {
  theta: number;
  r: number;
  energy: number;
  spectrum: { bass: number; mid: number; treble: number };
}

function polarToCartesian(theta: number, r: number): { x: number; y: number } {
  return {
    x: Math.cos(theta) * r,
    y: Math.sin(theta) * r,
  };
}

export function simulateParticles(
  flowField: FlowFieldPoint[],
  params: FlowParams,
  particleCount: number
): NeuralFlowResult {
  const noiseScale = params.noiseScale ?? (DEFAULT_PARAMS.noiseScale as number);
  const baseRadius = params.baseRadius ?? DEFAULT_PARAMS.baseRadius;
  const paths: PathPoint[][] = [];

  for (let p = 0; p < particleCount; p++) {
    const path: PathPoint[] = [];
    const angleOffset = (p / particleCount) * Math.PI * 2;
    const radiusOffset = (Math.sin(p * 7.3) * 0.5) * baseRadius * 0.05;

    let lastX = 0, lastY = 0;

    for (let i = 0; i < flowField.length; i++) {
      const point = flowField[i];

      let noiseTheta: number;
      let noiseR: number;
      if (i === 0) {
        noiseTheta = angleOffset;
        noiseR = point.r + radiusOffset;
      } else {
        noiseTheta = angleOffset + (Math.random() - 0.5) * noiseScale;
        noiseR = point.r + radiusOffset + (Math.random() - 0.5) * baseRadius * noiseScale;
      }

      const x = Math.cos(point.theta + noiseTheta) * noiseR;
      const y = Math.sin(point.theta + noiseTheta) * noiseR;

      let outX: number, outY: number;
      if (i === 0) {
        // First point: no smoothing from origin
        outX = x;
        outY = y;
      } else {
        // Smooth the path by interpolating between previous point and current
        outX = lastX * 0.7 + x * 0.3;
        outY = lastY * 0.7 + y * 0.3;
      }
      lastX = outX;
      lastY = outY;

      path.push({
        x: outX,
        y: outY,
        energy: point.energy,
        spectrum: { ...point.spectrum },
      });
    }

    paths.push(path);
  }

  return {
    paths,
    metadata: {
      eegSteps: flowField.length,
      audioFrames: flowField.length,
      duration: 0,
    },
  };
}
