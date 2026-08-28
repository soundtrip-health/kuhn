// Pure formatting for the citation hover card (STH-42): how a stored
// reference (or a parsed .bib entry) reads as an author line, a one-line
// summary, a source line and a set of outbound links. No DOM, no I/O — the
// card (cite-card.ts) renders these; bib.ts assembles the ReferenceView.

export interface ReferenceView {
  key: string;
  /** Author names as stored — "Family, Given" (PubMed FAU) or free-form. */
  authors: string[];
  year: string;
  title: string;
  journal: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  doi?: string;
  pmid?: string;
  url?: string;
}

/** Authors shown in full on the card before collapsing to "… et al.". */
export const AUTHOR_LIMIT = 5;

/** "Smith, John A" → "Smith JA"; "John Smith" stays as-is. */
export function shortAuthor(name: string): string {
  const trimmed = name.trim();
  const comma = trimmed.indexOf(',');
  if (comma < 0) return trimmed;
  const family = trimmed.slice(0, comma).trim();
  const initials = trimmed
    .slice(comma + 1)
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .join('');
  return initials ? `${family} ${initials}` : family;
}

/**
 * The card's author line: up to `limit` authors, then "… et al." with how
 * many were left out, so a reader can tell a 6-author paper from a 60-author
 * consortium at a glance.
 */
export function authorsLine(authors: string[], limit = AUTHOR_LIMIT): string {
  const names = authors.map(shortAuthor).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')}, … et al. (${names.length - limit} more)`;
}

/** Family name of the first author, for the "Smith et al. (2024)" summary. */
function familyName(name: string): string {
  const trimmed = name.trim();
  const comma = trimmed.indexOf(',');
  if (comma >= 0) return trimmed.slice(0, comma).trim();
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] ?? trimmed;
}

/** "Smith et al. (2024)" / "Smith & Doe (2024)" / "Smith (2024)". */
export function summaryLine(ref: Pick<ReferenceView, 'authors' | 'year'>): string {
  const families = ref.authors.map(familyName).filter(Boolean);
  const who =
    families.length === 0 ? '' : families.length > 2 ? `${families[0]} et al.` : families.join(' & ');
  return [who, ref.year ? `(${ref.year})` : ''].filter(Boolean).join(' ');
}

/** "Journal. 2024;12(3):45–67" — whatever parts are known, in that order. */
export function sourceLine(ref: Pick<ReferenceView, 'journal' | 'year' | 'volume' | 'issue' | 'pages'>): string {
  const cite = [
    ref.year,
    ref.volume ? `;${ref.volume}` : '',
    ref.issue ? `(${ref.issue})` : '',
    ref.pages ? `:${ref.pages.replace(/\s*-+\s*/, '–')}` : '',
  ].join('');
  return [ref.journal, cite].filter(Boolean).join('. ');
}

export interface ReferenceLink {
  label: string;
  href: string;
}

/** Outbound links for the details view, most authoritative first. */
export function referenceLinks(ref: Pick<ReferenceView, 'doi' | 'pmid' | 'url'>): ReferenceLink[] {
  const links: ReferenceLink[] = [];
  if (ref.doi) links.push({ label: `doi:${ref.doi}`, href: `https://doi.org/${encodeURI(ref.doi)}` });
  if (ref.pmid) links.push({ label: `PubMed ${ref.pmid}`, href: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(ref.pmid)}/` });
  if (ref.url && !links.some((l) => l.href === ref.url)) links.push({ label: 'Source', href: ref.url });
  return links;
}
