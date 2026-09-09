// Page breaks (`\newpage`) through the pandoc sandbox: the filter mount and
// argv are always present, and — when the pandoc image is available locally —
// the Lua filter really turns the marker into Typst/docx/html page breaks.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

vi.mock('./db.js', () => ({
  query: vi.fn(async (_sql, [id]) => ({ rows: Number(id) === 1 ? [{ root_path: null }] : [] })),
}));

import { config } from './config.js';
import {
  pandocConvert, PANDOC_FILTERS_DIR, PANDOC_FILTERS_MOUNT, PANDOC_LUA_FILTERS,
} from './sandbox.js';

const SOURCE = [
  'Intro para.', '', '\\newpage', '', 'Second page. Inline \\newpage here.', '',
  '\\pagebreak', '', '<div style="page-break-after: always;"></div>', '', 'End.', '',
].join('\n');

let root;
let savedProjectsRoot;

beforeAll(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-pagebreak-'));
  config.agent.projectsRoot = root;
  await mkdir(join(root, '1'), { recursive: true });
  await writeFile(join(root, '1', 'doc.md'), SOURCE);
});

afterAll(async () => {
  config.agent.projectsRoot = savedProjectsRoot;
  await rm(root, { recursive: true, force: true });
});

// Fake docker: records argv, drops an output file where /out is mounted.
function fakeSpawn() {
  const impl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    impl.args = args;
    const outDir = args.find((a) => a.endsWith(':/out')).slice(0, -'/out'.length - 1);
    const outName = args[args.indexOf('-o') + 1].split('/').pop();
    writeFile(join(outDir, outName), 'ok').then(() => child.emit('close', 0));
    return child;
  };
  return impl;
}

describe('pandocConvert page-break filter', () => {
  it('mounts the shipped filters read-only and runs pagebreak.lua on every conversion', async () => {
    const spawn = fakeSpawn();
    await pandocConvert(1, 'doc.md', 'export.docx', ['--standalone'], spawn);
    const args = spawn.args;
    expect(PANDOC_LUA_FILTERS).toContain('pagebreak.lua');
    expect(args).toContain(`${PANDOC_FILTERS_DIR}:${PANDOC_FILTERS_MOUNT}:ro`);
    expect(args).toContain(`--lua-filter=${PANDOC_FILTERS_MOUNT}/pagebreak.lua`);
    // filter args are pandoc options: after the image, before the output
    expect(args.indexOf('--lua-filter=/filters/pagebreak.lua')).toBeGreaterThan(args.indexOf(config.sandbox.pandocImage));
    expect(args.indexOf('--lua-filter=/filters/pagebreak.lua')).toBeLessThan(args.indexOf('-o'));
    expect(await readFile(join(PANDOC_FILTERS_DIR, 'pagebreak.lua'), 'utf-8')).toContain('#pagebreak()');
  });
});

// Real pandoc, only where the sandbox image is already pulled (CI without
// docker skips). Uses the same sandboxed pandocConvert path as the app.
const hasPandocImage = spawnSync('docker', ['image', 'inspect', config.sandbox.pandocImage], { stdio: 'ignore' }).status === 0;

/** Extract one entry from a zip buffer (docx) — enough for word/document.xml. */
function unzipEntry(buf, name) {
  const nameBuf = Buffer.from(name);
  let pos = 0;
  while ((pos = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), pos)) !== -1) {
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const entryName = buf.subarray(pos + 30, pos + 30 + nameLen);
    const dataStart = pos + 30 + nameLen + extraLen;
    if (entryName.equals(nameBuf)) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf-8');
    }
    pos = dataStart + compSize;
  }
  throw new Error(`${name} not in zip`);
}

describe.skipIf(!hasPandocImage)('pagebreak.lua (real pandoc)', () => {
  it('emits #pagebreak() for Typst — block, inline, \\pagebreak and the CSS div', async () => {
    const { output } = await pandocConvert(1, 'doc.md', 'preview.typ', ['--standalone']);
    const typ = output.toString('utf-8');
    expect(typ.match(/#pagebreak\(\)/g)).toHaveLength(4);
    expect(typ).not.toContain('\\newpage');
  }, 60_000);

  it('emits Word page breaks for docx', async () => {
    const { output } = await pandocConvert(1, 'doc.md', 'export.docx', ['--standalone']);
    const xml = unzipEntry(output, 'word/document.xml');
    expect(xml.match(/<w:br w:type="page"\/>/g)).toHaveLength(4);
    expect(xml).not.toContain('newpage');
  }, 60_000);

  it('leaves the raw TeX alone for LaTeX export', async () => {
    const { output } = await pandocConvert(1, 'doc.md', 'export.tex', ['--standalone']);
    const tex = output.toString('utf-8');
    expect(tex).toContain('\n\\newpage\n');
    expect(tex).toContain('\\pagebreak');
    expect(tex).not.toContain('#pagebreak');
  }, 60_000);
});
