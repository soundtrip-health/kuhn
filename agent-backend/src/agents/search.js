// Literature search backends for agent tools (story 011).
// Direct API calls — no API key required at low request rates.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/**
 * Search PubMed via NCBI E-utilities (esearch + esummary).
 * @param {string} searchQuery
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{pmid: string, title: string, authors: string[], journal: string, pubdate: string, doi: string|null}>>}
 */
export async function pubmedSearch(searchQuery, maxResults = 10) {
  const esearch = new URLSearchParams({
    db: 'pubmed',
    term: searchQuery,
    retmax: String(maxResults),
    retmode: 'json',
    sort: 'relevance',
  });
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
