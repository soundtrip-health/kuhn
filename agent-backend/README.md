# psyee — EEG Neural Flow Art Generator

Transform EEG brainwave data + synchronized audio into psychedelic SVG art.

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Generate art
node dist/cli.js input.eeg.jsonl input.audio.wav -o output.svg --palette neon --particles 64 --rotations 4
```

## Usage

```
psyee <eeg-file> <audio-file> [options]

Arguments:
  eeg-file            Path to EEG JSONL file
  audio-file          Path to WAV audio file

Options:
  -o, --output <file> Output SVG file path (default: "output.svg")
  --flow-scale <n>    EEG impact on path shape (default: 100)
  --audio-intensity <n> Audio impact on visual intensity (default: 0.5)
  --rotations <n>     Number of spiral rotations (default: 4)
  --particles <n>     Number of overlapping paths (default: 64)
  --palette <name>    Color palette: neon, sunset, void, aurora (default: "neon")
  --canvas-size <n>   SVG canvas dimensions (default: 800)
  --base-radius <n>   Base spiral radius (default: 100)
  --noise <n>         Random perturbation strength (default: 0.02)
  --line-width-min <n> Minimum path stroke width (default: 0.5)
  --line-width-max <n> Maximum path stroke width (default: 3)
  -h, --help          Display help
  -V, --version       Display version number
```

## EEG Data Format

JSONL file with one object per line:

```json
{"type":"eeg","index":0,"timestamp":1776306824000,"electrode":0,"samples":[1450.0,967.46]}
```

Each line has:
- `type`: always "eeg"
- `index`: time step index (grouping key)
- `timestamp`: millisecond timestamp
- `electrode`: electrode ID
- `samples`: array of sample values for this electrode at this time step

Multiple electrodes share the same index to form one time step.

## Palettes

- **neon** — Magenta, cyan, yellow, green, orange on dark blue
- **sunset** — Red-orange, gold, pink on deep maroon
- **void** — Pale blue, lavender, white, deep blue on absolute black
- **aurora** — Green, blue, purple, pink on dark forest night

## Architecture

The pipeline has four stages:

1. **JSONL Reader** — Parses EEG data, aggregates by time step index
2. **WAV Parser** — Decodes PCM audio, computes per-frame energy and frequency bands
3. **Flow Calculator** — Maps EEG activation to polar coordinates, modulated by audio
4. **Particle Simulator** — Spawns N particles that flow through the field with noise and smoothing
5. **SVG Renderer** — Converts paths to SVG with spectrum-driven colors

## Development

```bash
# Watch mode
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## License

MIT
