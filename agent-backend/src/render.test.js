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
    typstQueryBlocks: vi.fn(async () => [
      { i: 1, key: 'hello', page: 1, y: 72.04, h: 792, level: 1, text: 'Hello' },
      { i: 2, key: 'body', page: 2, y: 72, h: 792 },
      { i: -1, key: '', page: 2, y: 300.5, h: 792, limits: {} },
    ]),
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
// Typst templates: resolution is mocked here; the SQL lives in db/typst-templates.test.js.
vi.mock('./db/typst-templates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveTemplateSource: vi.fn(async () => null), resolveTemplateDocx: vi.fn(async () => null) };
});

import { config } from './config.js';
import { SandboxError, pandocConvert, renderMarp, renderTypstPdf, typstQueryBlocks } from './sandbox.js';
import { resolveThemeCss } from './db/slide-themes.js';
import { TemplateError, resolveTemplateDocx, resolveTemplateSource } from './db/typst-templates.js';
import { getProject } from './db/projects.js';
import { renderPdf, exportDocument, isMarpSource, marpThemeName, typstTemplateName, pageMapFromMarkers } from './render.js';

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
    await expect(exportDocument(1, 'draft/main.md', 'odt')).rejects.toThrow(RangeError);
  });

  it('pdf: the rendered PDF itself, named after the source (preview download)', async () => {
    const { output, contentType, filename } = await exportDocument(1, 'draft/main.md', 'pdf');
    expect(contentType).toBe('application/pdf');
    expect(filename).toBe('main.pdf');
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(pandocConvert).not.toHaveBeenCalled();
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
    expect(renderMarp).toHaveBeenCalledWith(1, 'draft/main.md', 'pptx', { themeName: undefined, themeCss: undefined, editablePptx: true });
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

describe('page map', () => {
  it('pageMapFromMarkers shapes markers into blocks + end, and tolerates junk', () => {
    expect(pageMapFromMarkers([
      { i: 1, key: 'a', page: 1, y: 10.04, h: 792 }, { i: 2, key: 'b', page: 3, y: 20, h: 792 }, { i: -1, key: '', page: 3, y: 99, h: 792 },
    ])).toEqual({ pages: 3, pageHeight: 792, blocks: [{ key: 'a', page: 1, y: 10 }, { key: 'b', page: 3, y: 20 }], end: { page: 3, y: 99 }, sections: [] });
    expect(pageMapFromMarkers([])).toBe(null);
    expect(pageMapFromMarkers([null, { i: 1, key: 'a', page: 1, y: 1, h: 792 }, 'x'])).toMatchObject({ pages: 1, end: { page: 1, y: 1 } });
  });

  it('sections: each budgeted heading measured to the next heading of its level or higher, in fractional pages', () => {
    const h = 792;
    const map = pageMapFromMarkers([
      { i: 1, key: 'specificaims', page: 1, y: 36, h, level: 1, text: 'Specific Aims' },
      { i: 2, key: 'para', page: 1, y: 60, h },
      { i: 3, key: 'aim1', page: 1, y: 400, h, level: 2, text: 'Aim 1' }, // deeper: stays inside Specific Aims
      { i: 4, key: 'researchstrategy', page: 2, y: 36 + 0.07 * h, h, level: 1, text: 'Research Strategy' },
      { i: 5, key: 'approach', page: 2, y: 300, h, level: 2, text: 'Approach' },
      { i: 6, key: 'refs', page: 3, y: 100, h, level: 1, text: 'References' },
      { i: -1, key: '', page: 3, y: 500, h, limits: { 'Specific aims': 1, 'research strategy': 12, Approach: 1, Missing: 3 } },
    ]);
    expect(map.sections).toEqual([
      { index: 0, title: 'Specific Aims', key: 'specificaims', page: 1, pages: 1.07, limit: 1, over: true },
      { index: 3, title: 'Research Strategy', key: 'researchstrategy', page: 2, pages: 1.01, limit: 12, over: false },
      { index: 4, title: 'Approach', key: 'approach', page: 2, pages: 0.75, limit: 1, over: false },
    ]);
    expect(pageMapFromMarkers([{ i: 1, key: 'a', page: 1, y: 1, h }, { i: -1, key: '', page: 1, y: 2, h }]).sections).toEqual([]);
  });

  it('renders with the blockmarks filter after citeproc, queries typst, and caches the map with the PDF', async () => {
    await writeFile(join(root, '1', 'draft', 'main.md'), `# Hello [@key] ${Math.random()}\n`);
    const first = await renderPdf(1, 'draft/main.md');
    expect(first.pageMap).toEqual({
      pages: 2, pageHeight: 792,
      blocks: [{ key: 'hello', page: 1, y: 72, level: 1, text: 'Hello' }, { key: 'body', page: 2, y: 72 }],
      end: { page: 2, y: 300.5 },
      sections: [],
    });
    const args = pandocConvert.mock.calls.at(-1)[3];
    expect(args.indexOf('--lua-filter=/filters/blockmarks.lua')).toBeGreaterThan(args.indexOf('--citeproc'));
    expect(typstQueryBlocks).toHaveBeenCalledWith(1, expect.stringMatching(/^draft\/\.preview-[0-9a-f]{12}\.typ$/));

    const second = await renderPdf(1, 'draft/main.md');
    expect(second.cached).toBe(true);
    expect(second.pageMap).toEqual(first.pageMap);
    expect(typstQueryBlocks).toHaveBeenCalledTimes(1);
  });

  it('a failed page query still returns the PDF, with pageMap null', async () => {
    await writeFile(join(root, '2', 'nobib.md'), `# Plain ${Math.random()}\n`);
    typstQueryBlocks.mockRejectedValueOnce(new SandboxError('failed', 'boom'));
    const out = await renderPdf(2, 'nobib.md');
    expect(out.pdf.toString()).toBe('%PDF-fake');
    expect(out.pageMap).toBe(null);
  });

  it('marp decks carry no page map', async () => {
    const out = await renderPdf(1, 'draft/deck.md');
    expect(out.pageMap).toBe(null);
    expect(typstQueryBlocks).not.toHaveBeenCalled();
  });
});

describe('typst templates', () => {
  it('typstTemplateName reads only the leading front matter', () => {
    expect(typstTemplateName('---\ntitle: T\ntemplate: nih-grant\n---\n')).toBe('nih-grant');
    expect(typstTemplateName('---\ntemplate: "manuscript"\n---\n')).toBe('manuscript');
    expect(typstTemplateName('---\ntitle: T\n---\n\ntemplate: nope\n')).toBe(null);
    expect(typstTemplateName('# no front matter\n')).toBe(null);
  });

  it('materializes the template beside the temp .typ, hands pandoc the variable, and cleans up', async () => {
    await writeFile(join(root, '1', 'draft', 'aims.md'), '---\ntemplate: nih-grant\n---\n\n# Aims\n');
    resolveTemplateSource.mockResolvedValueOnce({ name: 'nih-grant', source: '// @template nih-grant\nSRC1', origin: 'catalog' });
    const staged = [];
    renderTypstPdf.mockImplementationOnce(async (_pid, typPath) => {
      // Both temp files exist while typst runs, in the source's directory.
      const dir = join(root, '1', 'draft');
      staged.push(...(await readdir(dir)).filter((f) => f.startsWith('.preview-')));
      expect(typPath).toMatch(/^draft\/\.preview-[0-9a-f]{12}\.typ$/);
      return { output: Buffer.from('%PDF-fake'), stdout: '', stderr: '' };
    });
    const { cached } = await renderPdf(1, 'draft/aims.md');
    expect(cached).toBe(false);
    expect(resolveTemplateSource).toHaveBeenCalledWith(10, 'nih-grant'); // the project's org
    const args = pandocConvert.mock.calls.at(-1)[3];
    const tplArg = args.find((a) => a.startsWith('--variable=template='));
    expect(tplArg).toMatch(/^--variable=template=\.preview-[0-9a-f]{12}\.tpl\.typ$/);
    expect(staged.sort()).toEqual([`${tplArg.split('=')[2].replace('.tpl.typ', '')}.tpl.typ`, `${tplArg.split('=')[2].replace('.tpl.typ', '')}.typ`].sort());
    expect((await readdir(join(root, '1', 'draft'))).filter((f) => f.startsWith('.preview-'))).toEqual([]);

    // Same source bytes, changed template source → a fresh render, not a cache hit.
    resolveTemplateSource.mockResolvedValueOnce({ name: 'nih-grant', source: '// @template nih-grant\nSRC2', origin: 'org' });
    expect((await renderPdf(1, 'draft/aims.md')).cached).toBe(false);
  });

  it('documents without template: front matter pass no template variable', async () => {
    await writeFile(join(root, '2', 'nobib.md'), `# Plain ${Math.random()}\n`); // fresh bytes: no cache hit
    await renderPdf(2, 'nobib.md');
    expect(resolveTemplateSource).not.toHaveBeenCalled(); // no name → no library lookup
    const args = pandocConvert.mock.calls.at(-1)[3];
    expect(args.some((a) => a.startsWith('--variable=template='))).toBe(false);
  });

  it('falls back to the project default template when the front matter names none', async () => {
    getProject.mockResolvedValueOnce({ id: 2, org_id: 10, config: { template: 'manuscript' } });
    await writeFile(join(root, '2', 'nobib.md'), `# Plain ${Math.random()}\n`);
    resolveTemplateSource.mockResolvedValueOnce({ name: 'manuscript', source: '// @template manuscript\nMS', origin: 'catalog' });
    await renderPdf(2, 'nobib.md');
    expect(resolveTemplateSource).toHaveBeenCalledWith(10, 'manuscript');
    expect(pandocConvert.mock.calls.at(-1)[3].some((a) => a.startsWith('--variable=template='))).toBe(true);
  });

  it('docx export hands pandoc the template\'s Word reference document; tex does not', async () => {
    await writeFile(join(root, '1', 'draft', 'aims.md'), '---\ntemplate: nih-grant\n---\n\n# Aims\n');
    resolveTemplateDocx.mockResolvedValueOnce({ name: 'nih-grant', docx: Buffer.from('PK\x03\x04ref'), origin: 'catalog' });
    await exportDocument(1, 'draft/aims.md', 'docx');
    expect(resolveTemplateDocx).toHaveBeenCalledWith(10, 'nih-grant');
    expect(pandocConvert.mock.calls.at(-1)[4]).toEqual({ referenceDoc: Buffer.from('PK\x03\x04ref') });

    await exportDocument(1, 'draft/aims.md', 'tex');
    expect(pandocConvert.mock.calls.at(-1)[4]).toEqual({ referenceDoc: null });
    expect(resolveTemplateDocx).toHaveBeenCalledTimes(1);
  });

  it('an unknown template name fails the render with TemplateError, before pandoc runs', async () => {
    await writeFile(join(root, '1', 'draft', 'typo.md'), '---\ntemplate: nih-grnat\n---\n\n# Aims\n');
    resolveTemplateSource.mockRejectedValueOnce(new TemplateError('not_found', 'Unknown template "nih-grnat"'));
    await expect(renderPdf(1, 'draft/typo.md')).rejects.toBeInstanceOf(TemplateError);
    expect(pandocConvert).not.toHaveBeenCalled();
  });
});

describe('editable pptx fallback (STH-61)', () => {
  it('falls back to the default pptx when the editable conversion fails', async () => {
    renderMarp.mockRejectedValueOnce(new SandboxError('failed', 'LibreOffice soffice binary could not be found'));
    const out = await exportDocument(1, 'draft/main.md', 'pptx');
    expect(out.filename).toBe('main.pptx');
    expect(renderMarp).toHaveBeenCalledTimes(2);
    expect(renderMarp.mock.calls[0][3]).toMatchObject({ editablePptx: true });
    expect(renderMarp.mock.calls[1][3]).not.toHaveProperty('editablePptx');
  });

  it('does not mask timeouts as a fallback', async () => {
    renderMarp.mockRejectedValueOnce(new SandboxError('timeout', 'Sandbox timed out'));
    await expect(exportDocument(1, 'draft/main.md', 'pptx')).rejects.toMatchObject({ code: 'timeout' });
  });
});
