/**
 * Quality-baseline network fakes (STH-31).
 *
 * The production search and citation code (agents/search.js, citations.js)
 * fetches NCBI E-utilities and the arXiv export API through
 * globalThis.fetch. installEvalNetwork() swaps globalThis.fetch for a
 * fixture-driven responder so a baseline run is deterministic and makes
 * zero network calls — while the real fetch/parse/insert code paths run
 * untouched.
 *
 * The interceptor is a strict superset of the conformance harness's efetch
 * fake (conformance/fakes.js, installFetchFake): it also serves the
 * esearch/esummary JSON endpoints pubmedSearch() calls and the arXiv Atom
 * endpoint arxivSearch() calls. Query→record matching uses the same
 * substring semantics as conformance/fakes.js's fakePubmedSearch.
 *
 * Non-fixture URLs pass through to the real fetch and are logged in
 * handle.passthroughs — a non-empty list in the result record means the
 * run touched the real network and is not reproducible.
 */
import { nbibText } from '../conformance/fakes.js';

/** Query→PMID hits from the fixture, conformance-compatible semantics. */
function pubmedHits(literature, query) {
  const q = String(query).toLowerCase();
  for (const [key, pmids] of Object.entries(literature.searches ?? {})) {
    if (q.includes(key.toLowerCase())) {
      return pmids.filter((p) => (literature.pmids ?? {})[p] != null);
    }
  }
  const hits = Object.entries(literature.pmids ?? {})
    .filter(([, rec]) => JSON.stringify(rec).toLowerCase().includes(q.slice(0, 16)))
    .map(([pmid]) => pmid);
  return hits;
}

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Minimal Atom feed for arXiv hits (parseArxivFeed's expected shape). */
function atomFeed(hits) {
  const entries = hits
    .map((h) => {
      const id = h.id ?? h.url;
      const authors = (h.authors ?? [])
        .map((a) => `<author><name>${escapeXml(a)}</name></author>`)
        .join('');
      return `<entry>
<id>https://arxiv.org/abs/${escapeXml(id)}</id>
<title>${escapeXml(h.title ?? '')}</title>
${authors}
<summary>${escapeXml(h.summary ?? h.abstract ?? '')}</summary>
<published>${escapeXml(h.published ?? h.pubdate ?? '')}</published>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<title>fixture</title>\n${entries}\n</feed>`;
}

/**
 * Install the fixture fetch responder.
 * @param {object} literature - the corpus literature fixture
 *   { pmids: {<pmid>: {title, authors[], journal, pubdate, doi}},
 *     searches: {<query substring>: [pmid, ...]}, arxiv: {<query substring>: [hit, ...]} }
 * @returns {{ passthroughs: string[], restore: () => void }}
 */
export function installEvalNetwork(literature) {
  const passthroughs = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    try {
      // --- NCBI E-utilities -------------------------------------------------
      if (u.includes('eutils.ncbi.nlm.nih.gov')) {
        const parsed = new URL(u);
        const path = parsed.pathname;
        const ids = (parsed.searchParams.get('id') ?? '').split(',').filter(Boolean);

        if (path.endsWith('/esearch.fcgi')) {
          const term = parsed.searchParams.get('term') ?? '';
          const retmax = Number(parsed.searchParams.get('retmax') ?? 10) || 10;
          const idlist = pubmedHits(literature, term).slice(0, retmax);
          return new Response(JSON.stringify({ esearchresult: { idlist } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path.endsWith('/esummary.fcgi')) {
          const result = {};
          for (const pmid of ids) {
            const rec = (literature.pmids ?? {})[pmid];
            if (!rec) continue;
            result[pmid] = {
              uid: pmid,
              title: rec.title,
              authors: (rec.authors ?? []).map((name) => ({ name })),
              fulljournalname: rec.journal,
              pubdate: rec.pubdate,
              articleids: rec.doi ? [{ idtype: 'doi', value: rec.doi }] : [],
            };
          }
          return new Response(JSON.stringify({ result }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (path.endsWith('/efetch.fcgi')) {
          const pmid = ids[0] ?? '';
          const rec = (literature.pmids ?? {})[pmid];
          if (!rec) return new Response('', { status: 404 });
          return new Response(nbibText(pmid, rec), {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response('fixture: unknown eutils endpoint', { status: 404 });
      }

      // --- arXiv export -----------------------------------------------------
      if (u.includes('export.arxiv.org/api/query')) {
        const parsed = new URL(u);
        const raw = parsed.searchParams.get('search_query') ?? '';
        const query = raw.replace(/^all:/, '');
        let hits = [];
        for (const [key, value] of Object.entries(literature.arxiv ?? {})) {
          if (query.toLowerCase().includes(key.toLowerCase())) {
            hits = value.slice(0, Number(parsed.searchParams.get('max_results') ?? 10) || 10);
            break;
          }
        }
        return new Response(atomFeed(hits), {
          status: 200,
          headers: { 'content-type': 'application/atom+xml' },
        });
      }
    } catch (err) {
      // A malformed URL must not take the run down: log and pass through.
      passthroughs.push(`${u} (fixture error: ${err.message})`);
    }
    passthroughs.push(u.split('?')[0]);
    return realFetch(url, opts);
  };

  return {
    passthroughs,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}
