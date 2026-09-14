// Feature guide index (issue #170): parsing, idempotent seeding, ranked
// search — and the coverage contract on the shipped docs/features/ pages:
// every agent, every front-matter key Kuhn interprets, and every page named
// in the guide README must be documented. (Slash-command coverage is asserted
// from the webapp side, webapp/src/slash-commands.test.ts, where the registry lives.)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHIPPED_GUIDE = resolve(__dirname, '../../../docs/features');

let guide;
let config;
let exec;
let querySync;
let root;

const page = (title, body, extra = '') =>
  `---\ntitle: ${title}\narea: editor\nkeywords: alpha, beta${extra}\n---\n\n# ${title}\n\n${body}\n`;

beforeAll(async () => {
  ({ exec, querySync } = await import('../db.js'));
  ({ config } = await import('../config.js'));
  exec(readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8'));
  root = await mkdtemp(join(tmpdir(), 'kuhn-guide-'));
  config.guide.root = root;
  guide = await import('./guide.js');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  querySync('DELETE FROM guide_pages');
});

describe('parseGuidePage', () => {
  it('reads title/area/keywords and rejects pages without front matter or title', () => {
    const p = guide.parseGuidePage('x.md', page('Editor', 'Body.'));
    expect(p).toMatchObject({ file: 'x.md', title: 'Editor', area: 'editor', keywords: 'alpha, beta' });
    expect(p.body.startsWith('# Editor')).toBe(true);
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => guide.parseGuidePage('y.md', '# no front matter')).toThrow(/missing front matter/);
    expect(() => guide.parseGuidePage('z.md', '---\narea: a\n---\nbody')).toThrow(/no title/);
  });
});

describe('seedFeatureGuide', () => {
  it('indexes pages by section, skips unchanged ones, and removes pages that disappear', async () => {
    await writeFile(join(root, 'README.md'), '# not a page');
    await writeFile(join(root, 'editor.md'), page('Editor', '## Page limits\n\nAdd `page_limits:` to the front matter.\n\n## Chips\n\nType `\\newpage`.'));
    await writeFile(join(root, 'files.md'), page('Files', '## Uploads\n\nDrop a file on the tree.'));

    let r = await guide.seedFeatureGuide();
    expect(r).toEqual({ indexed: 2, unchanged: 0, removed: 0, pages: 2 });
    expect(guide.listGuidePages().map((p) => p.file)).toEqual(['editor.md', 'files.md']);
    const sections = querySync('SELECT heading_path FROM guide_sections ORDER BY page_id, seq').rows.map((s) => s.heading_path);
    expect(sections).toEqual(['Editor > Page limits', 'Editor > Chips', 'Files > Uploads']);

    r = await guide.seedFeatureGuide();
    expect(r).toEqual({ indexed: 0, unchanged: 2, removed: 0, pages: 2 });

    await writeFile(join(root, 'editor.md'), page('Editor', '## Page limits\n\nChanged text.'));
    await rm(join(root, 'files.md'));
    r = await guide.seedFeatureGuide();
    expect(r).toEqual({ indexed: 1, unchanged: 0, removed: 1, pages: 1 });
    expect(guide.guidePageCount()).toBe(1);
    expect(querySync('SELECT COUNT(*) AS n FROM guide_sections').rows[0].n).toBe(1);
    // FTS shadow follows the deletes (triggers): the removed page is unsearchable.
    expect(guide.searchGuide('uploads')).toEqual([]);
  });

  it('tolerates a missing guide directory (empty guide, not a crash)', async () => {
    const r = await guide.seedFeatureGuide(join(root, 'does-not-exist'));
    expect(r).toEqual({ indexed: 0, unchanged: 0, removed: 0, pages: 0 });
  });
});

describe('searchGuide', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'editor.md'), page('Editor',
      '## Page limits\n\nAdd `page_limits:` to the front matter; the heading gets a badge, red when over.\n\n'
      + '## Page lines\n\nDashed lines show where the PDF turns a page. They come from the last render.\n\n'
      + '## Saving\n\nEdits autosave.'));
    await writeFile(join(root, 'preview.md'), page('Preview and export',
      '## Preview PDF\n\nRenders the open document to PDF; every page is measured.\n\n## Export Word\n\nUses the template reference docx.',
      ', export, word, docx'));
    await guide.seedFeatureGuide();
  });

  it('ranks the section whose heading matches above body-only mentions', () => {
    const hits = guide.searchGuide('page limits');
    expect(hits[0]).toMatchObject({ file: 'editor.md', title: 'Editor', headingPath: 'Editor > Page limits' });
    expect(hits[0].text).toContain('page_limits');
    expect(hits[0].snippet).toContain('>>');
  });

  it('stems, falls back to OR for partial matches, and caps the limit', () => {
    // porter: "rendering" matches "render"
    expect(guide.searchGuide('rendering')[0].headingPath).toBe('Editor > Page lines');
    // one term absent from every section: OR fallback still finds the export section
    expect(guide.searchGuide('docx unicorn')[0].headingPath).toBe('Preview and export > Export Word');
    expect(guide.searchGuide('page', 1)).toHaveLength(1);
    expect(guide.searchGuide('   ')).toEqual([]);
    // operator characters are neutralised, not passed to FTS5
    expect(() => guide.searchGuide('page* AND ("limits')).not.toThrow();
  });
});

describe('the shipped docs/features guide', () => {
  let pages;
  let text;

  beforeAll(async () => {
    pages = await guide.loadGuidePages(SHIPPED_GUIDE);
    text = pages.map((p) => `${p.title}\n${p.keywords ?? ''}\n${p.body}`).join('\n');
  });

  it('parses every page, and every page named in the README exists', () => {
    const readme = readFileSync(join(SHIPPED_GUIDE, 'README.md'), 'utf-8');
    const listed = [...readme.matchAll(/^\| `([a-z-]+\.md)` \|/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThanOrEqual(8);
    const files = pages.map((p) => p.file);
    for (const f of listed) expect(files, `README lists ${f}`).toContain(f);
    for (const p of pages) {
      expect(p.area, `${p.file} has an area`).toBeTruthy();
      expect(guide.sectionsOf(p).length, `${p.file} has sections`).toBeGreaterThan(1);
    }
  });

  it('documents every agent and every front-matter key Kuhn interprets', async () => {
    const { AGENTS } = await import('./seed-data.js');
    const { FRONT_MATTER_KEYS } = await import('../render.js');
    for (const a of AGENTS) {
      const mentioned = text.includes(a.name) || new RegExp(`\\b${a.slug}\\b`).test(text);
      expect(mentioned, `agent ${a.slug} (${a.name}) is documented`).toBe(true);
    }
    for (const key of FRONT_MATTER_KEYS) {
      expect(text.includes(`\`${key}:`) || text.includes(`\`${key}\``), `front-matter key ${key} is documented`).toBe(true);
    }
  });

  it('indexes and answers a known question', async () => {
    await guide.seedFeatureGuide(SHIPPED_GUIDE);
    expect(guide.guidePageCount()).toBe(pages.length);
    const hits = guide.searchGuide('page limits');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('editor.md');
  });

  it('survives a synonym-padded query (the first production question)', async () => {
    await guide.seedFeatureGuide(SHIPPED_GUIDE);
    // Haiku's actual query for "why don't I see page lines?": nine words, no
    // section contains them all, and under plain OR-BM25 "tables"/"settings"
    // outranked the section named "Page lines" — so the agent denied a
    // documented feature. The heading tier + coverage re-rank must win.
    const hits = guide.searchGuide('page lines pagination display page breaks ruler view settings');
    // "Page breaks" legitimately ties (the query names it too); both must be in the top two.
    expect(hits.slice(0, 2).map((h) => h.headingPath).join(' | ')).toMatch(/Page lines/);
    expect(guide.searchGuide('dashed page lines editor')[0].headingPath).toMatch(/Page lines|Page map/);
    expect(guide.searchGuide('how do I export to word?')[0].headingPath).toMatch(/Export/);
  });
});
