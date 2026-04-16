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
