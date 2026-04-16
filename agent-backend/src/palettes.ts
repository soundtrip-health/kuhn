export interface ColorPalette {
  name: string;
  stops: [number, number, number][];
  background: [number, number, number];
}

export const PALETTES: Record<string, ColorPalette> = {
  neon: {
    name: 'Neon',
    stops: [
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 0],
      [0, 255, 128],
      [255, 128, 0],
    ],
    background: [5, 5, 15],
  },
  sunset: {
    name: 'Sunset',
    stops: [
      [255, 60, 0],
      [255, 140, 0],
      [255, 200, 50],
      [255, 80, 80],
    ],
    background: [15, 5, 10],
  },
  void: {
    name: 'Void',
    stops: [
      [200, 200, 255],
      [150, 150, 255],
      [255, 255, 255],
      [100, 100, 200],
    ],
    background: [2, 2, 8],
  },
  aurora: {
    name: 'Aurora',
    stops: [
      [0, 255, 100],
      [0, 200, 255],
      [100, 0, 255],
      [255, 0, 200],
    ],
    background: [3, 5, 10],
  },
};

export function getPalette(name: string): ColorPalette {
  return PALETTES[name] || PALETTES['neon'];
}

export function rgbToString(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

export function interpolateColor(
  c1: [number, number, number],
  c2: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}
