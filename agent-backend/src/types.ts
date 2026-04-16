export interface EegJsonlLine {
  type: string;
  index: number;
  timestamp: number;
  electrode: number;
  samples: number[];
}

export interface EegTimeStep {
  index: number;
  timestamp: number;
  electrodes: Map<number, number[]>;
}

export interface AudioFrame {
  energy: number;
  bass: number;
  mid: number;
  treble: number;
}

export interface EegFlowState {
  index: number;
  timestamp: number;
  activation: number;
  direction: { x: number; y: number };
}

export interface FlowParams {
  rotations: number;
  flowScale: number;
  audioIntensity: number;
  baseRadius: number;
  noiseScale?: number;
  particleCount?: number;
  canvasSize?: number;
  lineWidthMin?: number;
  lineWidthMax?: number;
  colorPalette?: string;
}

export const DEFAULT_PARAMS: FlowParams = {
  rotations: 2,
  flowScale: 50,
  audioIntensity: 1,
  baseRadius: 100,
  noiseScale: 0.3,
  particleCount: 100,
  canvasSize: 800,
  lineWidthMin: 1,
  lineWidthMax: 5,
  colorPalette: 'neon',
};

export interface PathPoint {
  x: number;
  y: number;
  energy: number;
  spectrum: { bass: number; mid: number; treble: number };
}

export interface ParticleFlowMetadata {
  eegSteps: number;
  audioFrames: number;
  duration: number;
}

export interface NeuralFlowResult {
  paths: PathPoint[][];
  metadata: ParticleFlowMetadata;
}
