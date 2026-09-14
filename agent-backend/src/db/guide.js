/**
 * Kuhn feature guide index (issue #170). docs/features/*.md is the
 * user-facing guide the in-app `help` agent answers from. At startup (and on
 * `npm run db:seed`) every page is parsed (YAML front matter: title, area,
 * keywords), split heading-aware into sections (ingest.js chunkText, the same
 * splitter the org library uses) and stored in guide_pages / guide_sections,
 * whose FTS5 shadow (guide_fts) the `search_kuhn_guide` tool queries.
 *
 * Platform-scoped: the guide describes Kuhn itself, so there is no org_id and
 * no per-tenant enablement. Pages are re-indexed only when their sha256
 * changes; pages that disappear from the directory are removed.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import { config } from '../config.js';
import { querySync, transaction } from '../db.js';
import { chunkText } from '../ingest.js';

/** Files in the guide directory that are not pages. */
const NON_PAGES = new Set(['README.md']);

export class GuideError extends Error {
  constructor(message, file) {
    super(file ? `${file}: ${message}` : message);
    this.file = file;
  }
}

/**
 * Parse one guide page. Front matter is a small fixed YAML subset:
 * `title:` (required), `area:` and `keywords:` (optional, plain scalars).
 * @returns {{ file: string, title: string, area: string|null, keywords: string|null, body: string, hash: string }}
 */
export function parseGuidePage(file, raw) {
  const text = String(raw).replace(/^﻿/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!fm) throw new GuideError('missing front matter (--- title: … ---)', file);
  const meta = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  if (!meta.title) throw new GuideError('front matter has no title', file);
  const body = text.slice(fm[0].length).trim();
  if (!body) throw new GuideError('page has no body', file);
  return {
    file,
    title: meta.title,
    area: meta.area || null,
    keywords: meta.keywords || null,
    body,
    hash: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * Read and parse every page under the guide root (sorted by file name).
 * A missing directory yields [] — a deploy without docs/features/ simply has
 * an empty guide (the help agent says so).
 */
export async function loadGuidePages(root = config.guide?.root) {
  if (!root) return []; // no guide configured (e.g. a test rig that mocks config)
  let names;
  try {
    names = await readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const pages = [];
  for (const name of names.sort()) {
    if (extname(name) !== '.md' || NON_PAGES.has(name)) continue;
    const raw = await readFile(resolve(root, name), 'utf-8');
    pages.push(parseGuidePage(basename(name), raw));
  }
  return pages;
}

/**
 * Sections of one page: heading-aware chunks whose first line is the section
 * heading path, so a hit reads as "Editor > Page limits" even when the
 * matched text is deep in the section. The page title is the H1, so
 * chunkText already prefixes every path with it.
 */
export function sectionsOf(page) {
  return chunkText(page.body, 'markdown').map((c) => ({
    seq: c.seq,
    headingPath: c.headingPath,
    text: c.text,
  }));
}

/**
 * Index the guide: unchanged pages (same hash) are left alone, changed or new
 * pages are replaced section by section, pages no longer on disk are deleted
 * (cascade removes their sections; the FTS triggers keep the index in sync).
 * @returns {Promise<{ indexed: number, unchanged: number, removed: number, pages: number }>}
 */
export async function seedFeatureGuide(root = config.guide?.root) {
  const pages = await loadGuidePages(root);
  const existing = new Map(
    querySync('SELECT id, file, hash FROM guide_pages').rows.map((r) => [r.file, r]),
  );
  let indexed = 0;
  let unchanged = 0;
  transaction(() => {
    for (const page of pages) {
      const prior = existing.get(page.file);
      existing.delete(page.file);
      if (prior && prior.hash === page.hash) {
        unchanged += 1;
        continue;
      }
      if (prior) querySync('DELETE FROM guide_pages WHERE id = $1', [prior.id]);
      const { rows } = querySync(
        `INSERT INTO guide_pages (file, title, area, keywords, hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [page.file, page.title, page.area, page.keywords, page.hash],
      );
      const pageId = rows[0].id;
      for (const s of sectionsOf(page)) {
        querySync(
          `INSERT INTO guide_sections (page_id, seq, heading_path, title, keywords, text)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [pageId, s.seq, s.headingPath, page.title, page.keywords, s.text],
        );
      }
      indexed += 1;
    }
    for (const gone of existing.values()) {
      querySync('DELETE FROM guide_pages WHERE id = $1', [gone.id]);
    }
  });
  const removed = existing.size;
  if (indexed || removed) {
    console.log(`[seed] Feature guide: ${indexed} page(s) indexed, ${unchanged} unchanged, ${removed} removed.`);
  }
  return { indexed, unchanged, removed, pages: pages.length };
}

/** Number of indexed pages — lets the tool tell "no guide" from "no match". */
export function guidePageCount() {
  return querySync('SELECT COUNT(*) AS n FROM guide_pages').rows[0].n;
}

/** Page list (file, title, area) in file order — for tests and the tool's fallback. */
export function listGuidePages() {
  return querySync('SELECT file, title, area, keywords FROM guide_pages ORDER BY file').rows;
}

/**
 * Question words carry no signal and, with the OR fallback, would match every
 * section ("how do I export to word" must rank on export/word). Dropped only
 * when a content word remains.
 */
const STOPWORDS = new Set((
  'a an and are as at be but by can do does for from how i in is it its my not of on or that the '
  + 'this to what when where which who why with you your'
).split(' '));

/** FTS5 has its own operator syntax; quote every term so input is literal words. */
function sanitizeFtsTerms(query) {
  const terms = String(query)
    .split(/\s+/)
    .map((term) => term.replace(/["*:^(){}?,.!;]/g, ''))
    .filter(Boolean);
  const content = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return (content.length ? content : terms).map((term) => `"${term}"`);
}

/**
 * Section search in three tiers. (1) Every term, any column — the precise
 * hit. (2) Any term in the HEADING tier (heading path, page title, keywords):
 * a question about "page lines" must land on the section named that even
 * when the model padded the query with synonyms. (3) Any term in the body.
 * Tiers 2–3 are re-ranked by how many query terms a section covers (heading
 * hits count double) before BM25, because with OR semantics BM25 lets one
 * rare stray word ("ruler", "settings") outrank a section matching the two
 * words that matter — the failure that made the help agent deny a documented
 * feature on its first production question.
 * @returns {Array<{ file, title, area, headingPath, seq, text, snippet, rank }>}
 */
export function searchGuide(query, limit = 4) {
  const terms = sanitizeFtsTerms(query);
  if (terms.length === 0) return [];
  const cap = Math.min(Math.max(parseInt(limit) || 4, 1), 10);
  const exact = ftsQuery(terms.join(' '), cap);
  if (exact.length >= cap || terms.length < 2) return exact;

  const seen = new Set(exact.map(sectionKey));
  const take = (rows) => rows.filter((r) => !seen.has(sectionKey(r)) && seen.add(sectionKey(r)));
  const any = terms.join(' OR ');
  const headings = take(rerank(ftsQuery(`{heading_path title keywords} : (${any})`, cap * 4), terms));
  const body = take(rerank(ftsQuery(any, cap * 4), terms));
  return [...exact, ...headings, ...body].slice(0, cap);
}

const sectionKey = (r) => `${r.file}#${r.seq}`;

/** Stem-ish prefix for coverage counting (porter does the real stemming in FTS). */
const stem = (term) => {
  const t = term.replace(/"/g, '').toLowerCase();
  return t.length > 5 ? t.slice(0, Math.max(4, t.length - 2)) : t.replace(/s$/, '');
};

/** Sort by covered query terms (heading hits ×2), then BM25. */
function rerank(rows, terms) {
  const stems = terms.map(stem);
  const scored = rows.map((r) => {
    const head = `${r.headingPath ?? ''} ${r.title ?? ''}`.toLowerCase();
    const text = r.text.toLowerCase();
    let score = 0;
    for (const st of stems) {
      if (head.includes(st)) score += 2;
      else if (text.includes(st)) score += 1;
    }
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || a.r.rank - b.r.rank);
  return scored.map((x) => x.r);
}

function ftsQuery(match, cap) {
  const { rows } = querySync(
    `SELECT p.file, p.title, p.area, s.heading_path AS headingPath, s.seq, s.text,
            snippet(guide_fts, 0, '>>', '<<', ' … ', 20) AS snippet,
            bm25(guide_fts, 1.0, 5.0, 2.0, 3.0) AS rank
     FROM guide_fts
     JOIN guide_sections s ON s.id = guide_fts.rowid
     JOIN guide_pages p ON p.id = s.page_id
     WHERE guide_fts MATCH $1
     ORDER BY rank
     LIMIT ${cap}`,
    [match],
  );
  return rows;
}
