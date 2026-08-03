import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./db.js', () => ({
  query: vi.fn(async (_sql, [id]) => ({
    rows: [1, 2].includes(Number(id)) ? [{ root_path: null }] : [],
  })),
}));

// References live in the DB; render materializes the .bib from it. These tests
// drive the .bib via on-disk fixtures, so stub materialization to a no-op.
vi.mock('./db/references.js', () => ({
  DEFAULT_BIB_PATH: 'draft/references.bib',
  materializeBib: vi.fn(async () => false),
}));

vi.mock('./sandbox.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pandocConvert: vi.fn(async () => ({ output: Buffer.from('= typst'), stdout: '', stderr: '' })),
    renderTypstPdf: vi.fn(async () => ({ output: Buffer.from('%PDF-fake'), stdout: '', stderr: '' })),
  };
});

import { config } from './config.js';
import { pandocConvert, renderTypstPdf } from './sandbox.js';
import { renderPdf, exportDocument } from './render.js';

let root;
let savedProjectsRoot;

beforeAll(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-render-'));
  config.agent.projectsRoot = root;
  await mkdir(join(root, '1', 'draft'), { recursive: true });
  await writeFile(join(root, '1', 'draft', 'main.md'), '# Hello [@key]\n');
  await writeFile(join(root, '1', 'draft', 'references.bib'), '@article{key, title={T}}\n');
  // A document nested away from draft/ — must still cite against the one
  // canonical bib (story 012-003), with the temp .typ staged next to itself.
  await mkdir(join(root, '1', 'notes', 'sub'), { recursive: true });
  await writeFile(join(root, '1', 'notes', 'sub', 'deep.md'), '# Deep [@key]\n');
  // Project 2 has no bibliography anywhere.
  await mkdir(join(root, '2'), { recursive: true });
  await writeFile(join(root, '2', 'nobib.md'), '# Plain\n');
});

afterAll(async () => {
  config.agent.projectsRoot = savedProjectsRoot;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('renderPdf', () => {
  it('converts via pandoc with citeproc and compiles the temp typst file', async () => {
    await writeFile(join(root, '1', 'draft', 'main.md'), `# Hello [@key] ${Math.random()}\n`);
    const { pdf, cached } = await renderPdf(1, 'draft/main.md');
    expect(pdf.toString()).toBe('%PDF-fake');
    expect(cached).toBe(false);

    const [, , , pandocArgs] = pandocConvert.mock.calls[0];
    expect(pandocArgs).toContain('--citeproc');
    expect(pandocArgs).toContain('--bibliography=/work/draft/references.bib');

    const [, typPath] = renderTypstPdf.mock.calls[0];
    expect(typPath).toMatch(/^draft\/\.preview-[0-9a-f]{12}\.typ$/);
    // The intermediate .typ is removed after the compile
    const leftover = (await readdir(join(root, '1', 'draft'))).filter((n) => n.endsWith('.typ'));
    expect(leftover).toEqual([]);
  });

  it('serves unchanged content from the cache', async () => {
    await writeFile(join(root, '1', 'draft', 'main.md'), '# Cached run\n');
    const first = await renderPdf(1, 'draft/main.md');
    expect(first.cached).toBe(false);
    const second = await renderPdf(1, 'draft/main.md');
    expect(second.cached).toBe(true);
    expect(pandocConvert).toHaveBeenCalledTimes(1);

    await writeFile(join(root, '1', 'draft', 'main.md'), '# Cached run, edited\n');
    const third = await renderPdf(1, 'draft/main.md');
    expect(third.cached).toBe(false);
  });

  it('cites a nested document against the canonical bibliography (012-003)', async () => {
    await renderPdf(1, 'notes/sub/deep.md');
    const [, , , pandocArgs] = pandocConvert.mock.calls[0];
    expect(pandocArgs).toContain('--citeproc');
    expect(pandocArgs).toContain('--bibliography=/work/draft/references.bib');
    // The temp .typ stays next to its source so relative sibling paths resolve.
    const [, typPath] = renderTypstPdf.mock.calls[0];
    expect(typPath).toMatch(/^notes\/sub\/\.preview-[0-9a-f]{12}\.typ$/);
    // No bib copy is scattered into the rendered-from folder.
    const scattered = await readdir(join(root, '1', 'notes', 'sub'));
    expect(scattered).not.toContain('references.bib');
  });

  it('omits citeproc when the project has no bibliography', async () => {
    await renderPdf(2, 'nobib.md');
    const [, , , pandocArgs] = pandocConvert.mock.calls[0];
    expect(pandocArgs).not.toContain('--citeproc');
  });

  it('cleans up the temp typst file when the compile fails', async () => {
    renderTypstPdf.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'failed' }));
    await writeFile(join(root, '1', 'draft', 'main.md'), '# Failing run\n');
    await expect(renderPdf(1, 'draft/main.md')).rejects.toThrow('boom');
    const leftover = (await readdir(join(root, '1', 'draft'))).filter((n) => n.endsWith('.typ'));
    expect(leftover).toEqual([]);
  });

  it('propagates not_found for a missing source', async () => {
    await expect(renderPdf(1, 'draft/missing.md')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('shares one sandbox run between concurrent renders of the same content', async () => {
    await writeFile(join(root, '1', 'draft', 'main.md'), '# Concurrent run\n');
    const [a, b] = await Promise.all([
      renderPdf(1, 'draft/main.md'),
      renderPdf(1, 'draft/main.md'),
    ]);
    expect(pandocConvert).toHaveBeenCalledTimes(1);
    expect(a.pdf.toString()).toBe('%PDF-fake');
    expect(b.pdf.toString()).toBe('%PDF-fake');
  });
});

describe('exportDocument', () => {
  it('exports docx with a derived filename', async () => {
    const { output, contentType, filename } = await exportDocument(1, 'draft/main.md', 'docx');
    expect(output.toString()).toBe('= typst');
    expect(contentType).toContain('officedocument');
    expect(filename).toBe('main.docx');
    const [, , outputName, pandocArgs] = pandocConvert.mock.calls[0];
    expect(outputName).toBe('export.docx');
    expect(pandocArgs).toContain('--standalone');
  });

  it('rejects unknown formats', async () => {
    await expect(exportDocument(1, 'draft/main.md', 'pdf')).rejects.toThrow(RangeError);
  });
});
