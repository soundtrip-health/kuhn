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
