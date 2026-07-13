import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Real in-memory SQLite (FTS5 + triggers are the substance) + temp org root.
// The sandbox is never invoked for real: binary-format tests inject a fake
// runner via the `runner` parameter.
process.env.KUHN_SQLITE_PATH = ':memory:';

const __dirname = dirname(fileURLToPath(import.meta.url));

let exec; let querySync; let config;
let extractText; let chunkText; let ingestOrgDocument; let IngestError;
let insertOrgDocument; let searchOrgKnowledge; let countDocumentChunks; let getOrgDocument;
let writeOrgFile;
let subscribeOrgEvents;
let orgsRoot;

beforeAll(async () => {
  ({ exec, querySync } = await import('./db.js'));
  ({ config } = await import('./config.js'));
  exec(readFileSync(resolve(__dirname, 'db/schema.sql'), 'utf-8'));
  orgsRoot = await mkdtemp(join(tmpdir(), 'kuhn-ingest-'));
  config.storage.orgsRoot = orgsRoot;

  ({ extractText, chunkText, ingestOrgDocument, IngestError } = await import('./ingest.js'));
  ({ insertOrgDocument, searchOrgKnowledge, countDocumentChunks, getOrgDocument } =
    await import('./db/org-documents.js'));
  ({ writeOrgFile } = await import('./storage.js'));
  ({ subscribeOrgEvents } = await import('./project-events.js'));
});

afterAll(async () => {
  await rm(orgsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  querySync('DELETE FROM org_documents'); // cascades chunks; triggers clean FTS
  querySync('DELETE FROM organizations');
  querySync("INSERT INTO organizations (id, name, slug) VALUES (1, 'A', 'a'), (2, 'B', 'b')");
});

/** Store bytes + row the way storeOrgDocument does, without the route layer. */
async function plantDoc(orgId, filename, content, sha) {
  const { document } = insertOrgDocument({
    orgId, filename, sizeBytes: content.length, sha256: sha,
  });
  await writeOrgFile(orgId, `${document.id}/${filename}`, content);
  return document;
}

describe('chunkText (story 006-002)', () => {
  it('tracks heading paths and starts a fresh chunk per section', () => {
    const text = '# Methods\n\nIntro para.\n\n## Statistics\n\nUse CIs.\n\n# Results\n\nFindings.';
    const chunks = chunkText(text, 'markdown');
    expect(chunks.map((c) => c.headingPath)).toEqual(['Methods', 'Methods > Statistics', 'Results']);
    expect(chunks[1].text).toContain('Use CIs.');
  });

  it('respects the size bounds and splits oversized blocks', () => {
    const saved = { ...config.ingest };
    Object.assign(config.ingest, { chunkTargetChars: 100, chunkMaxChars: 140 });
    try {
      const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`).join('\n\n');
      const chunks = chunkText(text, 'plain');
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(140 + 2);
      const single = chunkText('y'.repeat(500), 'plain');
      expect(single.length).toBeGreaterThanOrEqual(3); // hard-cap splits
    } finally {
      Object.assign(config.ingest, saved);
    }
  });
});

describe('extractText dispatch', () => {
  it('reads md/txt in-process without touching the sandbox', async () => {
    const doc = await plantDoc(1, 'notes.md', '# Hi\n\nBody', 'sha-md');
    const runner = vi.fn();
    const out = await extractText(1, doc, runner);
    expect(out).toEqual({ text: '# Hi\n\nBody', format: 'markdown' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('routes docx through pandoc and pdf through poppler, sandboxed', async () => {
    const docx = await plantDoc(1, 'sop.docx', 'fake-docx-bytes', 'sha-docx');
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '# From pandoc', stderr: '' }));
    expect(await extractText(1, docx, runner)).toEqual({ text: '# From pandoc', format: 'markdown' });
    expect(runner.mock.calls[0][0]).toMatchObject({
      image: config.sandbox.pandocImage,
      cmd: ['/work/sop.docx', '-t', 'gfm', '--wrap=none'],
    });

    const pdf = await plantDoc(1, 'guide.pdf', 'fake-pdf-bytes', 'sha-pdf');
    runner.mockResolvedValue({ exitCode: 0, stdout: 'pdf text', stderr: '' });
    expect(await extractText(1, pdf, runner)).toEqual({ text: 'pdf text', format: 'plain' });
    expect(runner.mock.calls[1][0]).toMatchObject({ image: config.sandbox.popplerImage });
    expect(runner.mock.calls[1][0].cmd).toContain('pdftotext');
    expect(runner.mock.calls[1][0].cmd).toContain(String(config.ingest.maxPdfPages));
  });

  it('rejects unsupported types with a readable IngestError', async () => {
    const doc = await plantDoc(1, 'weird.xyz', 'bytes', 'sha-xyz');
    await expect(extractText(1, doc, vi.fn())).rejects.toBeInstanceOf(IngestError);
  });
});

describe('ingestOrgDocument lifecycle', () => {
  it('txt → ready with FTS-searchable chunks, emitting status events', async () => {
    const doc = await plantDoc(
      1, 'policy.txt',
      'General notes about writing.\n\nAlways report the xylophone coefficient with confidence intervals.',
      'sha-policy',
    );
    const events = [];
    const unsub = subscribeOrgEvents(1, (e) => events.push(e));
    await ingestOrgDocument(1, doc.id);
    unsub();

    expect(getOrgDocument(1, doc.id).status).toBe('ready');
    expect(countDocumentChunks(doc.id)).toBeGreaterThan(0);
    expect(events.map((e) => e.status)).toEqual(['ingesting', 'ready']);

    const hits = searchOrgKnowledge(1, 'xylophone coefficient');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ docId: doc.id, filename: 'policy.txt' });
    expect(hits[0].snippet).toContain('>>');
  });

  it('scopes search to the org and to ready documents only', async () => {
    const doc = await plantDoc(1, 'a.txt', 'the zanzibar protocol applies here', 'sha-a');
    await ingestOrgDocument(1, doc.id);
    expect(searchOrgKnowledge(2, 'zanzibar').length).toBe(0); // other org
    querySync("UPDATE org_documents SET status = 'failed' WHERE id = $1", [doc.id]);
    expect(searchOrgKnowledge(1, 'zanzibar').length).toBe(0); // not ready
  });

  it('fails soft with a readable detail when there is no extractable text', async () => {
    const pdf = await plantDoc(1, 'scan.pdf', 'binary', 'sha-scan');
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '   \n ', stderr: '' }));
    await ingestOrgDocument(1, pdf.id, runner);
    const after = getOrgDocument(1, pdf.id);
    expect(after.status).toBe('failed');
    expect(after.status_detail).toContain('no extractable text');
  });

  it('re-ingestion replaces chunks instead of appending', async () => {
    const doc = await plantDoc(1, 'evolving.txt', 'first version of the quokka guideline', 'sha-ev');
    await ingestOrgDocument(1, doc.id);
    const firstCount = countDocumentChunks(doc.id);
    await writeOrgFile(1, `${doc.id}/evolving.txt`, 'second version of the quokka guideline, revised');
    await ingestOrgDocument(1, doc.id);
    expect(countDocumentChunks(doc.id)).toBe(firstCount);
    const hits = searchOrgKnowledge(1, 'quokka revised');
    expect(hits).toHaveLength(1);
  });

  it('deleting the document clears its chunks from the index', async () => {
    const doc = await plantDoc(1, 'temp.txt', 'the ephemeral wombat clause', 'sha-tmp');
    await ingestOrgDocument(1, doc.id);
    expect(searchOrgKnowledge(1, 'wombat').length).toBe(1);
    querySync('DELETE FROM org_documents WHERE id = $1', [doc.id]);
    expect(searchOrgKnowledge(1, 'wombat').length).toBe(0);
  });

  it('survives hostile FTS query syntax', () => {
    expect(() => searchOrgKnowledge(1, 'AND (NEAR "unclosed')).not.toThrow();
    expect(searchOrgKnowledge(1, '   ')).toEqual([]);
  });

  it('falls back to OR matching when no chunk contains every term (story 006-003)', async () => {
    const doc = await plantDoc(1, 'margins.txt', 'the capybara margin must be prespecified', 'sha-or');
    await ingestOrgDocument(1, doc.id);
    // "levitation" appears nowhere: all-terms matching returns nothing, the
    // OR retry still surfaces the capybara passage; ranking favors more hits.
    const hits = searchOrgKnowledge(1, 'capybara margin levitation');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ docId: doc.id, filename: 'margins.txt' });
    // A single absent term alone never matches anything even via OR.
    expect(searchOrgKnowledge(1, 'levitation')).toEqual([]);
  });
});
