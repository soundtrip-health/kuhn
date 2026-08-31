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
    renderMarp: vi.fn(async () => ({ output: Buffer.from('%PDF-marp'), stdout: '', stderr: '' })),
  };
});

// STH-58: theme resolution hits the project row and the theme library —
// both mocked here; the SQL substance lives in db/slide-themes.test.js.
vi.mock('./db/projects.js', () => ({
  getProject: vi.fn(async (id) => ({ id: Number(id), org_id: 10 })),
}));
vi.mock('./db/slide-themes.js', () => ({
  MARP_BUILTIN_THEMES: ['default', 'gaia', 'uncover'],
  resolveThemeCss: vi.fn(async () => null),
}));

import { config } from './config.js';
import { pandocConvert, renderMarp, renderTypstPdf } from './sandbox.js';
import { resolveThemeCss } from './db/slide-themes.js';
import { renderPdf, exportDocument, isMarpSource, marpThemeName } from './render.js';

let root;
let savedProjectsRoot;

beforeAll(async () => {
  savedProjectsRoot = config.agent.projectsRoot;
  root = await mkdtemp(join(tmpdir(), 'kuhn-render-'));
  config.agent.projectsRoot = root;
  await mkdir(join(root, '1', 'draft'), { recursive: true });
  await writeFile(join(root, '1', 'draft', 'main.md'), '# Hello [@key]\n');
  await writeFile(join(root, '1', 'draft', 'references.bib'), '@article{key, title={T}}\n');
  // A Marp slide deck (STH-57) — routed through renderMarp, not pandoc/typst.
  await writeFile(join(root, '1', 'draft', 'deck.md'), '---\nmarp: true\ntheme: default\n---\n\n# Slide\n');
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

describe('marp slide decks (STH-57)', () => {
  it('isMarpSource: only marp: true in the LEADING front matter opts in', () => {
    expect(isMarpSource('---\nmarp: true\n---\n\n# Hi\n')).toBe(true);
    expect(isMarpSource('---\ntheme: x\nmarp: true\n---\n\nbody')).toBe(true);
    expect(isMarpSource(Buffer.from('---\r\nmarp: true\r\n---\r\n# H'))).toBe(true);
    expect(isMarpSource('# Hi\n\nmarp: true\n')).toBe(false);
    expect(isMarpSource('---\nmarp: false\n---\n')).toBe(false);
    expect(isMarpSource('body first\n\n---\nmarp: true\n---\n')).toBe(false);
  });

  it('renders a marp deck through renderMarp, skipping pandoc/typst and the bib', async () => {
    const { pdf, cached } = await renderPdf(1, 'draft/deck.md');
    expect(pdf.toString()).toBe('%PDF-marp');
    expect(cached).toBe(false);
    expect(renderMarp).toHaveBeenCalledWith(1, 'draft/deck.md', 'pdf', { themeName: undefined, themeCss: undefined });
    expect(pandocConvert).not.toHaveBeenCalled();
    expect(renderTypstPdf).not.toHaveBeenCalled();
    const again = await renderPdf(1, 'draft/deck.md');
    expect(again.cached).toBe(true);
    expect(renderMarp).toHaveBeenCalledTimes(1);
  });

  it('exports pptx via marp for any markdown; docx still goes through pandoc', async () => {
    const out = await exportDocument(1, 'draft/main.md', 'pptx');
    expect(renderMarp).toHaveBeenCalledWith(1, 'draft/main.md', 'pptx', { themeName: undefined, themeCss: undefined });
    expect(out.filename).toBe('main.pptx');
    expect(out.contentType).toMatch(/presentationml/);
    expect(pandocConvert).not.toHaveBeenCalled();

    await exportDocument(1, 'draft/main.md', 'docx');
    expect(pandocConvert).toHaveBeenCalledTimes(1);
  });
});

describe('marp slide themes (STH-58)', () => {
  it('marpThemeName reads only the leading front matter', () => {
    expect(marpThemeName('---\nmarp: true\ntheme: kuhn-dark\n---\n')).toBe('kuhn-dark');
    expect(marpThemeName('---\nmarp: true\ntheme: "kuhn"\n---\n')).toBe('kuhn');
    expect(marpThemeName('---\nmarp: true\n---\n\ntheme: nope\n')).toBe(null);
    expect(marpThemeName('# no front matter\n')).toBe(null);
  });

  it('resolves a custom theme via the org and busts the cache when its CSS changes', async () => {
    await writeFile(join(root, '1', 'draft', 'themed.md'), '---\nmarp: true\ntheme: kuhn\n---\n\n# T\n');
    resolveThemeCss.mockResolvedValueOnce({ name: 'kuhn', css: 'CSS1', source: 'catalog' });
    const first = await renderPdf(1, 'draft/themed.md');
    expect(first.cached).toBe(false);
    expect(resolveThemeCss).toHaveBeenCalledWith(10, 'kuhn'); // the project's org
    expect(renderMarp).toHaveBeenLastCalledWith(1, 'draft/themed.md', 'pdf', { themeName: 'kuhn', themeCss: 'CSS1' });

    // Same source bytes, changed theme CSS → a fresh render, not a cache hit.
    resolveThemeCss.mockResolvedValueOnce({ name: 'kuhn', css: 'CSS2', source: 'org' });
    const second = await renderPdf(1, 'draft/themed.md');
    expect(second.cached).toBe(false);
    expect(renderMarp).toHaveBeenLastCalledWith(1, 'draft/themed.md', 'pdf', { themeName: 'kuhn', themeCss: 'CSS2' });
  });

  it('built-in theme names skip the library entirely', async () => {
    await renderPdf(1, 'draft/deck.md'); // fixture uses theme: default
    expect(resolveThemeCss).not.toHaveBeenCalled();
  });
});
