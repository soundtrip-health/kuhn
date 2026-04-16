import { NeuralFlowResult, FlowParams, DEFAULT_PARAMS } from './types';
import { getPalette, interpolateColor, rgbToString } from './palettes';

export function renderSvg(
  result: NeuralFlowResult,
  params: FlowParams = DEFAULT_PARAMS
): string {
  const { paths } = result;
  const canvasSize = params.canvasSize || DEFAULT_PARAMS.canvasSize!;
  const halfSize = canvasSize / 2;
  const palette = getPalette(params.colorPalette || DEFAULT_PARAMS.colorPalette!);
  const stops = palette.stops;
  const bg = rgbToString(...palette.background);

  const pathElements = paths.map((path, pIdx) => {
    if (path.length === 0) return '';

    let d = `M${path[0].x + halfSize},${path[0].y + halfSize}`;
    for (let i = 1; i < path.length; i++) {
      d += `L${path[i].x + halfSize},${path[i].y + halfSize}`;
    }

    const avgBass = path.reduce((s, p) => s + p.spectrum.bass, 0) / path.length;
    const avgMid = path.reduce((s, p) => s + p.spectrum.mid, 0) / path.length;
    const avgTreble = path.reduce((s, p) => s + p.spectrum.treble, 0) / path.length;

    const spectrumWeight = avgBass * 0.2 + avgMid * 0.5 + avgTreble * 0.8;
    const colorIdx = spectrumWeight * (stops.length - 1);
    const idx = Math.floor(colorIdx);
    const frac = colorIdx - idx;
    const c1 = stops[Math.min(idx, stops.length - 1)];
    const c2 = stops[Math.min(idx + 1, stops.length - 1)];
    const color = rgbToString(...interpolateColor(c1, c2, frac));

    const avgEnergy = path.reduce((s, p) => s + p.energy, 0) / path.length;
    const lineWidthMin = params.lineWidthMin || DEFAULT_PARAMS.lineWidthMin!;
    const lineWidthMax = params.lineWidthMax || DEFAULT_PARAMS.lineWidthMax!;
    const width = lineWidthMin + avgEnergy * (lineWidthMax - lineWidthMin);
    const opacity = 0.3 + avgEnergy * 0.7;

    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width.toFixed(1)}" opacity="${opacity.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).filter(Boolean);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasSize} ${canvasSize}" width="${canvasSize}" height="${canvasSize}">
  <rect width="100%" height="100%" fill="${bg}"/>
  ${pathElements.join('\n  ')}
</svg>`;

  return svg;
}
