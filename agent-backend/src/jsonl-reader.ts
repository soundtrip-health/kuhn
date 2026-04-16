import { readFileSync } from 'fs';
import { EegJsonlLine, EegTimeStep } from './types';

export function parseJsonlLine(line: string): EegJsonlLine {
  return JSON.parse(line.trim()) as EegJsonlLine;
}

export function aggregateByIndex(lines: EegJsonlLine[]): EegTimeStep[] {
  const map = new Map<number, EegTimeStep>();

  for (const line of lines) {
    if (map.has(line.index)) {
      const step = map.get(line.index)!;
      step.electrodes.set(line.electrode, line.samples);
    } else {
      map.set(line.index, {
        index: line.index,
        timestamp: line.timestamp,
        electrodes: new Map([[line.electrode, line.samples]]),
      });
    }
  }

  return [...map.values()].sort((a, b) => a.index - b.index);
}

export async function readEegJsonl(filePath: string): Promise<EegTimeStep[]> {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const parsed = lines.map(parseJsonlLine);
  return aggregateByIndex(parsed);
}
