import { describe, it, expect } from 'vitest';
import { readEegJsonl, aggregateByIndex } from '../src/jsonl-reader';
import { EegJsonlLine, EegTimeStep } from '../src/types';
import { join } from 'path';

describe('aggregateByIndex', () => {
  it('groups lines by index', () => {
    const lines: EegJsonlLine[] = [
      { type: 'eeg', index: 0, timestamp: 1000, electrode: 0, samples: [1.0] },
      { type: 'eeg', index: 0, timestamp: 1000, electrode: 1, samples: [2.0] },
      { type: 'eeg', index: 1, timestamp: 2000, electrode: 0, samples: [3.0] },
    ];
    const result = aggregateByIndex(lines);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[0].electrodes.size).toBe(2);
    expect(result[0].electrodes.get(0)).toEqual([1.0]);
    expect(result[0].electrodes.get(1)).toEqual([2.0]);
    expect(result[1].index).toBe(1);
  });
});

describe('readEegJsonl', () => {
  it('reads and parses the mock file', async () => {
    const steps = await readEegJsonl(join(process.cwd(), 'tests/fixtures/mock-eeg.jsonl'));
    expect(steps).toHaveLength(4);
    expect(steps[0].index).toBe(0);
    expect(steps[0].electrodes.size).toBe(3);
    expect(steps[3].index).toBe(3);
  });
});
