// Literature search backends for agent tools (story 011).
// Direct API calls — no API key required at low request rates. PubMed calls
// optionally attach an NCBI api_key (the org's `ncbi-api-key` secret, resolved
// by the caller) for the higher E-utilities rate limit.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/**
 * Search PubMed via NCBI E-utilities (esearch + esummary).
 * @param {string} searchQuery
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{pmid: string, title: string, authors: string[], journal: string, pubdate: string, doi: string|null}>>}
 */
export async function pubmedSearch(searchQuery, maxResults = 10, { apiKey = null } = {}) {
  const esearch = new URLSearchParams({
    db: 'pubmed',
    term: searchQuery,
    retmax: String(maxResults),
    retmode: 'json',
    sort: 'relevance',
  });
  if (apiKey) esearch.set('api_key', apiKey);
  const searchRes = await fetch(`${EUTILS}/esearch.fcgi?${esearch}`);
  if (!searchRes.ok) throw new Error(`PubMed esearch failed: HTTP ${searchRes.status}`);
  const { esearchresult } = await searchRes.json();
  const ids = esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const esummary = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json',
  });
  if (apiKey) esummary.set('api_key', apiKey);
  const summaryRes = await fetch(`${EUTILS}/esummary.fcgi?${esummary}`);
  if (!summaryRes.ok) throw new Error(`PubMed esummary failed: HTTP ${summaryRes.status}`);
  const { result } = await summaryRes.json();

  return ids
    .map((id) => result?.[id])
    .filter(Boolean)
    .map((doc) => ({
      pmid: doc.uid,
      title: doc.title,
      authors: (doc.authors ?? []).map((a) => a.name),
      journal: doc.fulljournalname || doc.source,
      pubdate: doc.pubdate,
      doi: doc.articleids?.find((a) => a.idtype === 'doi')?.value ?? null,
    }));
}

/**
 * Search arXiv via its Atom export API.
 * @param {string} searchQuery
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{id: string, title: string, authors: string[], summary: string, published: string, url: string}>>}
 */
export async function arxivSearch(searchQuery, maxResults = 10) {
  const params = new URLSearchParams({
    search_query: `all:${searchQuery}`,
    max_results: String(maxResults),
    sortBy: 'relevance',
  });
  const res = await fetch(`https://export.arxiv.org/api/query?${params}`);
  if (!res.ok) throw new Error(`arXiv query failed: HTTP ${res.status}`);
  const xml = await res.text();
  return parseArxivFeed(xml);
}

/**
 * Minimal Atom parser for arXiv responses — extracts the fields agents need
 * without pulling in an XML dependency.
 * @param {string} xml
 */
export function parseArxivFeed(xml) {
  const entries = xml.split('<entry>').slice(1);
  return entries.map((entry) => {
    const tag = (name) => {
      const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? decodeXml(m[1].trim()) : '';
    };
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
      .map((m) => decodeXml(m[1].trim()));
    const id = tag('id');
    return {
      id: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      title: tag('title').replace(/\s+/g, ' '),
      authors,
      summary: tag('summary').replace(/\s+/g, ' '),
      published: tag('published'),
      url: id,
    };
  });
}

function decodeXml(s) {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Normalize an arXiv identifier (STH-49): accepts a bare id ("2401.01234",
 * with or without version), an abs/pdf URL, or an "arXiv:" prefixed id.
 */
export function normalizeArxivId(id) {
  return String(id ?? '').trim()
    .replace(/^arxiv:\s*/i, '')
    .replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\.pdf$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Fetch one arXiv record by id (STH-49). Returns the parsed entry, or null
 * when arXiv has no such record. Every field comes from the arXiv API — this
 * is the grounding step behind the deterministic add_reference path.
 */
export async function arxivFetchById(arxivId) {
  const id = normalizeArxivId(arxivId);
  if (!id) return null;
  const params = new URLSearchParams({ id_list: id, max_results: '1' });
  const res = await fetch(`https://export.arxiv.org/api/query?${params}`);
  if (!res.ok) throw new Error(`arXiv query failed: HTTP ${res.status}`);
  const [entry] = parseArxivFeed(await res.text());
  // Unknown ids come back as an empty feed or an "Error" stub entry.
  if (!entry?.id || !entry.title || /^error/i.test(entry.title)) return null;
  return entry;
}

/**
 * Fetch a work's registered metadata from Crossref by DOI (STH-49). Returns
 * a normalized record, or null when the DOI is not registered.
 */
export async function crossrefFetchByDoi(doi) {
  const clean = String(doi ?? '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (!clean) return null;
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, {
    // Crossref asks polite clients to identify themselves.
    headers: { 'User-Agent': 'kuhn-agent-backend (https://github.com/soundtrip-health/kuhn)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Crossref lookup failed: HTTP ${res.status}`);
  const { message } = await res.json();
  return normalizeCrossrefWork(message);
}

/** Map a Crossref work message to the normalized shape citations.js consumes. */
export function normalizeCrossrefWork(message) {
  if (!message) return null;
  const authors = (message.author ?? [])
    .map((a) => (a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : (a.name ?? '')))
    .filter(Boolean);
  const year = message.issued?.['date-parts']?.[0]?.[0]
    ?? message['published-print']?.['date-parts']?.[0]?.[0]
    ?? message['published-online']?.['date-parts']?.[0]?.[0]
    ?? null;
  return {
    type: message.type ?? null,
    title: (message.title?.[0] ?? '').replace(/\s+/g, ' ').trim(),
    authors,
    year: year != null ? String(year) : null,
    journal: message['container-title']?.[0] ?? null,
    volume: message.volume ?? null,
    issue: message.issue ?? null,
    pages: message.page ?? null,
    publisher: message.publisher ?? null,
    doi: message.DOI ?? null,
    url: message.URL ?? null,
    // Crossref abstracts are JATS XML fragments; strip the markup.
    abstract: message.abstract
      ? message.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : null,
  };
}
