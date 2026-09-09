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
  pandocConvert, PANDOC_FILTERS_DIR, PANDOC_FILTERS_MOUNT, PANDOC_LUA_FILTERS, PANDOC_OPTIONAL_FILTERS,
} from './sandbox.js';

const AIMS = [
  '---', 'title: Aims', 'page_limits:', '  Specific Aims: 1', '  Research Strategy: 12', '  Bogus: nope', '---', '',
  '# Specific Aims', '', 'Aim text.', '', '## Aim 1', '', 'Detail.', '', '# Research Strategy', '', 'Strategy.', '',
].join('\n');

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
  await writeFile(join(root, '1', 'aims.md'), AIMS);
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

describe('pandocConvert argument validation', () => {
  it('accepts --variable=key=value (template files) and still rejects shell-ish arguments', async () => {
    const spawn = fakeSpawn();
    await pandocConvert(1, 'doc.md', 'preview.typ', ['--variable=template=.preview-a67d145f6a6b.tpl.typ'], spawn);
    expect(spawn.args).toContain('--variable=template=.preview-a67d145f6a6b.tpl.typ');
    for (const bad of ['-o /etc/passwd', '--variable=template=$(id)', '--lua-filter=/x;rm', 'plain']) {
      expect(() => pandocConvert(1, 'doc.md', 'preview.typ', [bad], spawn)).toThrow(/Invalid pandoc argument/);
    }
  });
});

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

  it('blockmarks.lua marks every top-level block (Typst only) with a fingerprint the webapp can recompute', async () => {
    const { output } = await pandocConvert(1, 'doc.md', 'preview.typ', ['--standalone', `--lua-filter=${PANDOC_OPTIONAL_FILTERS.blockmarks}`]);
    const typ = output.toString('utf-8');
    const markers = [...typ.matchAll(/#context \[#metadata\(\(i: (-?\d+), key: "([^"]*)", page: here\(\)\.page\(\)/g)];
    // 6 blocks in SOURCE (paragraph, pagebreak, paragraph, pagebreak, div→pagebreak, paragraph) + the end marker
    expect(markers.map((m) => m[1])).toEqual(['1', '2', '3', '4', '5', '6', '-1']);
    expect(markers[0][2]).toBe('intropara');
    expect(markers[2][2]).toBe('secondpageinlinehere'); // raw inline (the \newpage) contributes no text
    expect(markers[5][2]).toBe('end');
    expect(markers.at(-1)[2]).toBe('');
    expect(typ).toContain('<kuhn-block>');

    const { output: docx } = await pandocConvert(1, 'doc.md', 'export.docx', ['--standalone', `--lua-filter=${PANDOC_OPTIONAL_FILTERS.blockmarks}`]);
    expect(unzipEntry(docx, 'word/document.xml')).not.toContain('kuhn-block'); // no-op outside Typst
  }, 60_000);

  it('blockmarks.lua records heading level/text and the page_limits front matter on the end marker', async () => {
    const { output } = await pandocConvert(1, 'aims.md', 'preview.typ', ['--standalone', `--lua-filter=${PANDOC_OPTIONAL_FILTERS.blockmarks}`]);
    const typ = output.toString('utf-8');
    expect(typ).toContain('key: "specificaims", page: here().page(), y: here().position().y.pt(), h: page.height.to-absolute().pt(), level: 1, text: "Specific Aims"');
    expect(typ).toContain('level: 2, text: "Aim 1"');
    expect(typ).toContain('i: -1, key: "", page: here().page(), y: here().position().y.pt(), h: page.height.to-absolute().pt(), limits: ("Research Strategy": 12, "Specific Aims": 1)');
    expect(typ).not.toContain('Bogus'); // non-numeric limits dropped
    expect((await pandocConvert(1, 'doc.md', 'preview.typ', ['--standalone', `--lua-filter=${PANDOC_OPTIONAL_FILTERS.blockmarks}`])).output.toString()).toContain('limits: (:)');
  }, 60_000);

  it('leaves the raw TeX alone for LaTeX export', async () => {
    const { output } = await pandocConvert(1, 'doc.md', 'export.tex', ['--standalone']);
    const tex = output.toString('utf-8');
    expect(tex).toContain('\n\\newpage\n');
    expect(tex).toContain('\\pagebreak');
    expect(tex).not.toContain('#pagebreak');
  }, 60_000);
});
