#!/usr/bin/env node

import { Command } from 'commander';
import { readEegJsonl } from './jsonl-reader';
import { parseWav, computeAudioFrames } from './wav-parser';
import { computeFlowStates, computeFlowField } from './flow-field';
import { simulateParticles } from './particle-sim';
import { renderSvg } from './svg-renderer';
import { DEFAULT_PARAMS, FlowParams } from './types';
import { PALETTES } from './palettes';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const program = new Command();

program
  .name('psyee')
  .description('EEG Neural Flow Art Generator — turn brainwave data into psychedelic SVG art')
  .version('0.1.0')
  .argument('<eeg-file>', 'Path to EEG JSONL file')
  .argument('<audio-file>', 'Path to WAV audio file')
  .option('-o, --output <file>', 'Output SVG file path', 'output.svg')
  .option('--flow-scale <number>', 'EEG impact on path shape', String(DEFAULT_PARAMS.flowScale))
  .option('--audio-intensity <number>', 'Audio impact on visual intensity', String(DEFAULT_PARAMS.audioIntensity))
  .option('--rotations <number>', 'Number of spiral rotations', String(DEFAULT_PARAMS.rotations))
  .option('--particles <number>', 'Number of overlapping paths', String(DEFAULT_PARAMS.particleCount))
  .option('--palette <name>', `Color palette (${Object.keys(PALETTES).join(', ')})`, DEFAULT_PARAMS.colorPalette)
  .option('--canvas-size <number>', 'SVG canvas dimensions', String(DEFAULT_PARAMS.canvasSize))
  .option('--base-radius <number>', 'Base spiral radius', String(DEFAULT_PARAMS.baseRadius))
  .option('--noise <number>', 'Random perturbation strength', String(DEFAULT_PARAMS.noiseScale))
  .option('--line-width-min <number>', 'Minimum path stroke width', String(DEFAULT_PARAMS.lineWidthMin))
  .option('--line-width-max <number>', 'Maximum path stroke width', String(DEFAULT_PARAMS.lineWidthMax))
  .action(async (eegFile: string, audioFile: string, options: any) => {
    console.log('EEG Neural Flow Art Generator');
    console.log(`   EEG: ${eegFile}`);
    console.log(`   Audio: ${audioFile}`);
    console.log(`   Palette: ${options.palette}`);
    console.log('');

    const params: FlowParams = {
      ...DEFAULT_PARAMS,
      flowScale: parseFloat(options.flowScale),
      audioIntensity: parseFloat(options.audioIntensity),
      rotations: parseInt(options.rotations),
      particleCount: parseInt(options.particles),
      colorPalette: options.palette,
      canvasSize: parseInt(options.canvasSize),
      baseRadius: parseFloat(options.baseRadius),
      noiseScale: parseFloat(options.noise),
      lineWidthMin: parseFloat(options.lineWidthMin),
      lineWidthMax: parseFloat(options.lineWidthMax),
    };

    console.log('Reading EEG data...');
    const eegSteps = await readEegJsonl(eegFile);
    console.log(`   ${eegSteps.length} time steps, ${eegSteps[0]?.electrodes.size || 0} electrodes`);

    console.log('Parsing audio...');
    const { sampleRate, samples } = parseWav(audioFile);
    console.log(`   ${sampleRate}Hz, ${samples.length} samples`);

    const frameSize = Math.max(Math.floor(sampleRate / 30), 256);
    const audioFrames = computeAudioFrames(samples, frameSize);
    console.log(`   ${audioFrames.length} audio frames`);

    console.log('Computing neural flow field...');
    const electrodeCount = eegSteps[0]?.electrodes.size || 4;
    const electrodeLayout: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      electrodeLayout.push([Math.cos(angle), Math.sin(angle)]);
    }
    const flowStates = computeFlowStates(eegSteps, { electrodeLayout });

    const flowField = computeFlowField(flowStates, audioFrames, params);

    console.log('Simulating particles...');
    const result = simulateParticles(flowField, params, params.particleCount ?? DEFAULT_PARAMS.particleCount as number);
    console.log(`   ${result.paths.length} particles, ${result.paths[0]?.length || 0} steps each`);

    console.log('Rendering SVG...');
    const svg = renderSvg(result, params);

    const outDir = dirname(options.output);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {}
    writeFileSync(options.output, svg);
    console.log(`\nSaved to ${options.output}`);
    console.log(`   Size: ${Buffer.byteLength(svg) / 1024} KB`);
  });

program.parse();
