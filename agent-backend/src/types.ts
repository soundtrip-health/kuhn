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
}

export const DEFAULT_PARAMS: FlowParams = {
  rotations: 2,
  flowScale: 50,
  audioIntensity: 1,
  baseRadius: 100,
};
