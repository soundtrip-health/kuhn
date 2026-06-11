import { dumps, loads, type RisRecord } from "./rispy/index.js";
import { CitationGraph, Engine, Paper, loadFromJson, saveToJson, type SearchResult } from "./findpapers/index.js";

const PAPER_TYPE_TO_RIS: Record<string, string> = {
  article: "JOUR",
  inproceedings: "CPAPER",
  inbook: "CHAP",
  incollection: "CHAP",
  book: "BOOK",
  phdthesis: "THES",
  mastersthesis: "THES",
  techreport: "RPRT",
  unpublished: "UNPB",
  misc: "GEN",
};

const RIS_TO_BIB_TYPE: Record<string, string> = {
  JOUR: "article",
  JFULL: "article",
  ABST: "article",
  MGZN: "article",
  BOOK: "book",
  EDBOOK: "book",
  CHAP: "inbook",
  CONF: "inproceedings",
  CPAPER: "inproceedings",
  THES: "phdthesis",
  RPRT: "techreport",
  UNPB: "unpublished",
  GEN: "misc",
  ELEC: "misc",
  WEB: "misc",
  DATA: "misc",
  PCOMM: "misc",
};

export interface AddPapersResult {
  risText: string;
  added: number;
  skipped: number;
  selected: Paper[];
}

export interface ParseRefsResult {
  parsed: RisRecord[];
  doiList: string[];
  noDoiIndices: number[];
  added: number;
  skipped: number;
  risText: string;
  bibText?: string;
}

function ensureList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value)];
}

function normalizeDoi(value: unknown): string {
  return String(value ?? "").trim().replace(/[.,;)\s]+$/g, "").toLowerCase();
}

function recordIds(ref: RisRecord): Set<string> {
  const ids = new Set<string>();
  for (const key of ["accession_number", "pmid"] as const) {
    const value = ref[key];
    if (value) {
      ids.add(String(value).trim());
    }
  }
  const doi = normalizeDoi(ref.doi);
  if (doi) {
    ids.add(doi);
  }
  const url = String(ref.url ?? "").trim().toLowerCase();
  if (url) {
    ids.add(url);
  }
  return ids;
}

function paperIds(paper: Paper): Set<string> {
  const ids = new Set<string>();
  if (paper.doi) {
    ids.add(normalizeDoi(paper.doi));
  }
  if (paper.url) {
    ids.add(paper.url.trim().toLowerCase());
  }
  return ids;
}

export function sortPapers(papers: Paper[]): Paper[] {
  return [...papers].sort((a, b) => {
    const byCitations = (b.citations ?? 0) - (a.citations ?? 0);
    if (byCitations !== 0) {
      return byCitations;
    }
    const yearA = a.publicationDate?.getUTCFullYear() ?? 0;
    const yearB = b.publicationDate?.getUTCFullYear() ?? 0;
    return yearB - yearA;
  });
}

export function paperToRisRecord(paper: Paper): RisRecord {
  const out: RisRecord = {
    type_of_reference: PAPER_TYPE_TO_RIS[paper.paperType] ?? "GEN",
    title: paper.title,
  };
  if (paper.abstract) {
    out.abstract = paper.abstract;
  }
  if (paper.authors.length) {
    out.authors = paper.authors.map((author) => author.name);
  }
  if (paper.source) {
    out.journal_name = paper.source.title;
    if (paper.source.publisher) {
      out.publisher = paper.source.publisher;
    }
  }
  if (paper.publicationDate) {
    out.year = String(paper.publicationDate.getUTCFullYear());
  }
  if (paper.pageRange) {
    const parts = paper.pageRange.split(/[-\u2013\u2014]/, 2).map((part) => part.trim());
    out.start_page = parts[0];
    if (parts[1]) {
      out.end_page = parts[1];
    }
  }
  if (paper.doi) {
    out.doi = paper.doi;
  }
  if (paper.url) {
    out.url = paper.url;
  }
  if (paper.keywords.length) {
    out.keywords = [...paper.keywords].sort();
  }
  if (paper.language) {
    out.language = paper.language;
  }
  if (paper.citations !== undefined) {
    out.note = `Citation count: ${paper.citations}`;
  }
  return out;
}

export function loadRisText(risText: string): RisRecord[] {
  if (!risText.trim()) {
    return [];
  }
  return loads(risText);
}

export function saveRisText(records: RisRecord[]): string {
  return dumps(records);
}

export function addPapersToRis(papers: Paper[], currentRisText: string): AddPapersResult {
  const existing = loadRisText(currentRisText);
  const seen = new Set<string>();
  existing.forEach((ref) => recordIds(ref).forEach((id) => seen.add(id)));

  const selected: Paper[] = [];
  const toAdd: RisRecord[] = [];
  let skipped = 0;
  for (const paper of papers) {
    const ids = paperIds(paper);
    if (ids.size && [...ids].some((id) => seen.has(id))) {
      skipped += 1;
      continue;
    }
    selected.push(paper);
    toAdd.push(paperToRisRecord(paper));
    ids.forEach((id) => seen.add(id));
  }

  const risText = toAdd.length ? saveRisText([...existing, ...toAdd]) : currentRisText;
  return {
    risText,
    added: toAdd.length,
    skipped,
    selected,
  };
}

export function toBibTexEntry(ref: RisRecord): string {
  const type = RIS_TO_BIB_TYPE[String(ref.type_of_reference ?? "GEN")] ?? "misc";
  const explicitId = String(ref.id ?? "").trim();
  const key = explicitId
    ? explicitId.replace(/[^a-zA-Z0-9_:.-]/g, "_")
    : `${String((ensureList(ref.authors)[0] ?? "Unknown").split(",")[0]).replace(/[^a-zA-Z]/g, "") || "Unknown"}${(String(ref.year ?? "").match(/\d{4}/)?.[0] ?? "XXXX")}`;

  const fields: Record<string, string> = {};
  const authors = ensureList(ref.authors ?? ref.first_authors);
  if (authors.length) {
    fields.author = authors.join(" and ");
  }
  const title = ref.title ?? ref.primary_title ?? ref.short_title;
  if (title) {
    fields.title = String(title);
  }
  const year = String(ref.year ?? ref.publication_year ?? "").match(/\d{4}/)?.[0];
  if (year) {
    fields.year = year;
  }
  const journal = ref.journal_name ?? ref.alternate_title1 ?? ref.secondary_title ?? ref.full_journal_name;
  if (journal) {
    if (type === "article") {
      fields.journal = String(journal);
    } else if (type === "inproceedings" || type === "inbook") {
      fields.booktitle = String(journal);
    }
  }
  for (const [risField, bibField] of [
    ["volume", "volume"],
    ["number", "number"],
    ["doi", "doi"],
    ["url", "url"],
    ["issn", "issn"],
    ["isbn", "isbn"],
  ] as const) {
    if (ref[risField]) {
      fields[bibField] = String(ref[risField]);
    }
  }
  const startPage = String(ref.start_page ?? "").trim();
  const endPage = String(ref.end_page ?? "").trim();
  if (startPage && endPage) {
    fields.pages = `${startPage}--${endPage}`;
  } else if (startPage) {
    fields.pages = startPage;
  }
  if (ref.publisher) {
    fields.publisher = String(ref.publisher);
  }
  if (ref.place_published) {
    fields.address = String(ref.place_published);
  }
  if (ref.abstract) {
    fields.abstract = String(ref.abstract);
  }
  if (ref.note) {
    fields.note = String(ref.note);
  }

  const lines = [`@${type}{${key},`];
  const entries = Object.entries(fields);
  entries.forEach(([name, value], index) => {
    const escaped = value.replace(/&/g, "\\&").replace(/%/g, "\\%").replace(/#/g, "\\#");
    const comma = index < entries.length - 1 ? "," : "";
    lines.push(`  ${name} = {${escaped}}${comma}`);
  });
  lines.push("}");
  return lines.join("\n");
}

export function exportBibTex(risText: string): { bibText: string; exported: number } {
  const refs = loadRisText(risText);
  const entries = refs.map(toBibTexEntry);
  return {
    bibText: entries.length ? `${entries.join("\n\n")}\n` : "",
    exported: entries.length,
  };
}

export interface NbibRecord {
  publication_types?: string[];
  title?: string;
  abstract?: string;
  authors?: Array<{ author?: string; first_name?: string; last_name?: string } | string>;
  journal_abbreviated?: string;
  journal?: string;
  publication_date?: string;
  journal_volume?: string;
  journal_issue?: string;
  pages?: string;
  doi?: string;
  pubmed_id?: string;
  issn?: string;
  electronic_issn?: string;
  mesh_terms?: string[];
  keywords?: string[];
  language?: string[] | string;
}

export function parseNbibText(nbibText: string): NbibRecord[] {
  const lines = nbibText.split(/\r?\n/);
  const records: NbibRecord[] = [];
  let current: Record<string, unknown> = {};
  let lastTag = "";

  const pushCurrent = () => {
    if (Object.keys(current).length) {
      records.push(current as NbibRecord);
      current = {};
      lastTag = "";
    }
  };

  const addListField = (key: string, value: string) => {
    const list = (current[key] as string[] | undefined) ?? [];
    list.push(value);
    current[key] = list;
  };

  for (const line of lines) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }
    const match = line.match(/^([A-Z0-9]{2,4})\s*-\s*(.*)$/);
    if (!match) {
      if (lastTag && typeof current[lastTag] === "string") {
        current[lastTag] = `${String(current[lastTag])} ${line.trim()}`;
      }
      continue;
    }

    const [, tag, value] = match;
    lastTag = tag;
    if (tag === "PMID") current.pubmed_id = value;
    else if (tag === "TI") current.title = value;
    else if (tag === "AB") current.abstract = value;
    else if (tag === "JT") current.journal = value;
    else if (tag === "TA") current.journal_abbreviated = value;
    else if (tag === "DP") current.publication_date = value;
    else if (tag === "VI") current.journal_volume = value;
    else if (tag === "IP") current.journal_issue = value;
    else if (tag === "PG") current.pages = value;
    else if (tag === "LID" && value.includes("10.")) current.doi = value.split(" ")[0];
    else if (tag === "AID" && value.includes("10.")) current.doi = value.split(" ")[0];
    else if (tag === "IS") current.issn = value;
    else if (tag === "PT") addListField("publication_types", value);
    else if (tag === "MH") addListField("mesh_terms", value);
    else if (tag === "OT") addListField("keywords", value);
    else if (tag === "FAU") addListField("authors", value);
    else if (tag === "AU") addListField("authors", value);
    else if (tag === "LA") addListField("language", value);
  }
  pushCurrent();
  return records;
}

export function nbibToRisRecord(record: NbibRecord): RisRecord {
  const out: RisRecord = {};
  const publicationTypes = ensureList(record.publication_types).join(" ").toLowerCase();
  if (publicationTypes.includes("journal")) out.type_of_reference = "JOUR";
  else if (publicationTypes.includes("book") && publicationTypes.includes("chapter")) out.type_of_reference = "CHAP";
  else if (publicationTypes.includes("book")) out.type_of_reference = "BOOK";
  else if (publicationTypes.includes("conference")) out.type_of_reference = "CPAPER";
  else if (publicationTypes.includes("thesis") || publicationTypes.includes("dissertation")) out.type_of_reference = "THES";
  else if (publicationTypes.includes("report")) out.type_of_reference = "RPRT";
  else out.type_of_reference = "GEN";

  if (record.title) out.title = record.title;
  if (record.abstract) out.abstract = record.abstract;
  if (record.authors?.length) {
    out.authors = record.authors.map((author) => {
      if (typeof author === "string") return author;
      return author.author || `${author.last_name ?? ""}, ${author.first_name ?? ""}`.trim().replace(/^,\s*/, "");
    });
  }
  if (record.journal_abbreviated) out.journal_name = record.journal_abbreviated;
  if (record.journal) out.alternate_title1 = record.journal;
  if (record.publication_date) {
    const year = record.publication_date.match(/\b\d{4}\b/)?.[0];
    if (year) out.year = year;
  }
  if (record.journal_volume) out.volume = String(record.journal_volume);
  if (record.journal_issue) out.number = String(record.journal_issue);
  if (record.pages) {
    const parts = String(record.pages).split(/[-\u2013\u2014]/, 2).map((part) => part.trim());
    out.start_page = parts[0];
    if (parts[1]) out.end_page = parts[1];
  }
  if (record.doi) out.doi = record.doi;
  if (record.pubmed_id) out.accession_number = String(record.pubmed_id);
  const issn = record.issn || record.electronic_issn;
  if (issn) out.issn = String(issn);
  const keywords = record.mesh_terms || record.keywords;
  if (keywords?.length) out.keywords = keywords;
  if (record.language) out.language = Array.isArray(record.language) ? record.language[0] : String(record.language);
  return out;
}

export function importNbibToRis(nbibText: string, currentRisText: string): { risText: string; added: number; skipped: number } {
  const existing = loadRisText(currentRisText);
  const seen = new Set<string>();
  existing.forEach((record) => recordIds(record).forEach((id) => seen.add(id)));

  const parsed = parseNbibText(nbibText).map(nbibToRisRecord);
  const toAdd: RisRecord[] = [];
  let skipped = 0;
  for (const record of parsed) {
    const ids = recordIds(record);
    if (ids.size && [...ids].some((id) => seen.has(id))) {
      skipped += 1;
      continue;
    }
    toAdd.push(record);
    ids.forEach((id) => seen.add(id));
  }

  return {
    risText: toAdd.length ? saveRisText([...existing, ...toAdd]) : currentRisText,
    added: toAdd.length,
    skipped,
  };
}

const INITIALS_RE = /\b[A-Z]{1,4}\b/;

export function looksLikeAuthorList(text: string): boolean {
  const t = text.trim();
  if (t.length < 5) return true;
  if (t.length > 200) return false;
  if (/\bet al\.?\s*$/i.test(t)) return true;
  const chunks = t.split(",").map((chunk) => chunk.trim()).filter(Boolean);
  if (!chunks.length) return false;
  let initialsHits = 0;
  chunks.forEach((chunk) => {
    const tokens = chunk.split(/\s+/);
    if (tokens.length && INITIALS_RE.test(tokens[tokens.length - 1])) {
      initialsHits += 1;
    }
  });
  return initialsHits >= 1;
}

export function parseAuthorString(text: string): string[] {
  let normalized = text.trim();
  normalized = normalized.replace(/,?\s*et al\.?\s*$/i, "").trim();
  normalized = normalized.replace(/\s+and\s+/g, ", ").replace(/;/g, ",");
  const chunks = normalized.split(",").map((chunk) => chunk.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const tokens = chunk.split(/\s+/);
    const last = tokens[tokens.length - 1] ?? "";
    if (/^[A-Z]{1,4}$/.test(last)) {
      out.push(chunk);
    } else if (i + 1 < chunks.length && /^[A-Z]{1,4}$/.test(chunks[i + 1])) {
      out.push(`${chunk} ${chunks[i + 1]}`);
      i += 1;
    } else {
      out.push(chunk);
    }
  }
  return out;
}

export function splitRawReferences(text: string): string[] {
  const numberRegex = /^[ \t]*(?:\[?\d+[\]\.)\s]|\d+\.\s)/gm;
  const starts = Array.from(text.matchAll(numberRegex)).map((item) => item.index ?? -1).filter((item) => item >= 0);
  if (starts.length >= 2) {
    const parts: string[] = [];
    starts.forEach((start, index) => {
      const end = starts[index + 1] ?? text.length;
      const chunk = text.slice(start, end).replace(numberRegex, "").trim();
      if (chunk) {
        parts.push(chunk);
      }
    });
    return parts;
  }
  return text.trim().split(/\n[ \t]*\n/).map((chunk) => chunk.trim()).filter(Boolean);
}

export function parseOneReference(raw: string): RisRecord {
  const text = raw.replace(/\s+/g, " ").trim();
  const ref: RisRecord = { type_of_reference: "JOUR" };

  const doiMatch =
    text.match(/(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)\s*(10\.\d{4,}\/[^\s,;]+)/i) ??
    text.match(/\b(10\.\d{4,}\/[^\s,;]+)/);
  if (doiMatch) ref.doi = doiMatch[1].replace(/[.,;)\s]+$/g, "");

  const pmidMatch = text.match(/\bPMID[:\s]*(\d+)\b/i);
  if (pmidMatch) ref.accession_number = pmidMatch[1];

  const pmcidMatch = text.match(/\bPMC(\d+)\b/);
  if (pmcidMatch) ref.url = `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcidMatch[1]}/`;

  const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) ref.year = yearMatch[1];

  const volumeIssueMatch = text.match(/\b(\d{1,4})\((\d{1,4})\)/);
  if (volumeIssueMatch) {
    ref.volume = volumeIssueMatch[1];
    ref.number = volumeIssueMatch[2];
  }

  const pageMatch = text.match(/\b(\d{1,6}[a-z]?)\s*[-\u2013\u2014]\s*(\d{1,6}[a-z]?)\b/i);
  if (pageMatch) {
    const startNum = Number(pageMatch[1].replace(/[^0-9]/g, ""));
    const endNum = Number(pageMatch[2].replace(/[^0-9]/g, ""));
    const yearLike = !Number.isNaN(startNum) && !Number.isNaN(endNum) && startNum >= 1900 && startNum <= 2100 && endNum >= 1900 && endNum <= 2100;
    if (!yearLike) {
      ref.start_page = pageMatch[1];
      ref.end_page = pageMatch[2];
    }
  }

  const cleanText = text
    .replace(/(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)?\s*10\.\d{4,}\/\S+/gi, "")
    .replace(/[.,;]+$/g, "")
    .trim();
  const rawSentences = cleanText.split(/\.\s+/);
  const sentences: string[] = [];
  let buffer = "";
  rawSentences.forEach((item) => {
    let next = item;
    if (buffer) {
      next = `${buffer}. ${next}`;
      buffer = "";
    }
    const words = next.split(/\s+/);
    const lastWord = words[words.length - 1] ?? "";
    if (/^[a-z]{1,4}$/.test(lastWord)) {
      buffer = next;
    } else {
      sentences.push(next);
    }
  });
  if (buffer) sentences.push(buffer);

  const authorFirst = sentences.length > 0 && looksLikeAuthorList(sentences[0]);
  const authorIndex = authorFirst ? 0 : 1;
  const titleIndex = authorFirst ? 1 : 0;

  const titleCandidate = sentences[titleIndex]?.trim();
  if (titleCandidate && titleCandidate.length >= 10 && titleCandidate.length <= 400) {
    ref.title = titleCandidate;
  } else if (sentences.length) {
    ref.title = [...sentences].sort((a, b) => b.length - a.length)[0].slice(0, 350);
  }

  const authorText = sentences[authorIndex]?.trim();
  if (authorText) {
    const authors = parseAuthorString(authorText);
    if (authors.length) {
      ref.authors = authors;
    }
  }

  const journalIndex = Math.max(authorIndex, titleIndex) + 1;
  const journalCandidate = sentences[journalIndex]?.split(/[;,]/)[0]?.trim();
  if (journalCandidate && journalCandidate.length >= 2 && journalCandidate.length <= 120 && !/10\.\d{4,}\//.test(journalCandidate)) {
    ref.journal_name = journalCandidate;
  }

  ref.note = "Parsed from raw text — use apply-metadata to verify with PubMed";
  return ref;
}

export function parseReferencesToRis(inputText: string, currentRisText: string, withBib = false): ParseRefsResult {
  const rawRefs = splitRawReferences(inputText);
  const parsed = rawRefs.map(parseOneReference);
  const doiList = parsed.map((item) => normalizeDoi(item.doi)).filter(Boolean);
  const noDoiIndices = parsed.map((item, index) => ({ hasDoi: !!item.doi, index })).filter((item) => !item.hasDoi).map((item) => item.index);

  const existing = loadRisText(currentRisText);
  const seen = new Set<string>();
  existing.forEach((record) => recordIds(record).forEach((id) => seen.add(id)));

  const toAdd: RisRecord[] = [];
  let skipped = 0;
  parsed.forEach((record) => {
    const ids = recordIds(record);
    if (ids.size && [...ids].some((id) => seen.has(id))) {
      skipped += 1;
      return;
    }
    toAdd.push(record);
    ids.forEach((id) => seen.add(id));
  });

  const risText = toAdd.length ? saveRisText([...existing, ...toAdd]) : currentRisText;
  const bibText = withBib ? exportBibTex(risText).bibText : undefined;
  return {
    parsed,
    doiList,
    noDoiIndices,
    added: toAdd.length,
    skipped,
    risText,
    bibText,
  };
}

export function applyMetadata(metadata: Array<Record<string, unknown>>, risText: string): { risText: string; updated: number; unmatched: string[] } {
  const refs = loadRisText(risText);
  const byDoi = new Map<string, Record<string, unknown>>();
  metadata.forEach((item) => {
    const doi = normalizeDoi(item.doi);
    if (doi) byDoi.set(doi, item);
  });

  let updated = 0;
  const newRefs = refs.map((ref) => {
    const doi = normalizeDoi(ref.doi);
    const meta = byDoi.get(doi);
    if (!meta) {
      return ref;
    }

    const out: RisRecord = { ...ref };
    const fieldMap: Array<[string, string]> = [
      ["title", "title"],
      ["authors", "authors"],
      ["journal", "journal_name"],
      ["year", "year"],
      ["volume", "volume"],
      ["number", "number"],
      ["start_page", "start_page"],
      ["end_page", "end_page"],
      ["abstract", "abstract"],
      ["issn", "issn"],
      ["publisher", "publisher"],
    ];
    fieldMap.forEach(([source, target]) => {
      if (meta[source] !== undefined) {
        out[target] = meta[source];
      }
    });
    if (meta.pmid) {
      out.accession_number = String(meta.pmid);
    }
    if (meta.doi) {
      out.doi = String(meta.doi).replace(/[.,;)\s]+$/g, "");
    }
    out.note = "Metadata verified via PubMed";
    updated += 1;
    return out;
  });

  const risDoiSet = new Set(refs.map((ref) => normalizeDoi(ref.doi)).filter(Boolean));
  const unmatched = [...byDoi.keys()].filter((doi) => !risDoiSet.has(doi));
  return {
    risText: saveRisText(newRefs),
    updated,
    unmatched,
  };
}

export class CitationManager {
  constructor(private readonly engine: Engine) {}

  async search(params: {
    query: string;
    databases?: string[];
    since?: string;
    until?: string;
    maxPerDatabase?: number;
  }): Promise<{ result: SearchResult; json: string }> {
    const result = await this.engine.search(params.query, {
      databases: params.databases,
      maxPapersPerDatabase: params.maxPerDatabase,
      since: params.since ? new Date(params.since) : undefined,
      until: params.until ? new Date(params.until) : undefined,
    });
    result.papers = sortPapers(result.papers);
    return { result, json: saveToJson(result) };
  }

  async get(identifier: string, currentRisText: string): Promise<AddPapersResult> {
    const paper = await this.engine.get(identifier);
    if (!paper) {
      return { risText: currentRisText, added: 0, skipped: 0, selected: [] };
    }
    return addPapersToRis([paper], currentRisText);
  }

  async snowball(params: {
    seeds: string[];
    depth: number;
    direction: "both" | "forward" | "backward";
    topN?: number;
  }): Promise<{ graph: CitationGraph; discovered: Paper[]; graphJson: string; orderJson: string }> {
    const seedPapers: Paper[] = [];
    for (const identifier of params.seeds) {
      const paper = await this.engine.get(identifier);
      if (paper) {
        seedPapers.push(paper);
      }
    }
    const graph = await this.engine.snowball(seedPapers, {
      maxDepth: params.depth,
      direction: params.direction,
      topNPerLevel: params.topN,
    });
    const seedKeys = new Set(seedPapers.map((paper) => paper.key()));
    const discovered = sortPapers(graph.nodes.filter((paper) => !seedKeys.has(paper.key())));
    return {
      graph,
      discovered,
      graphJson: saveToJson(graph),
      orderJson: JSON.stringify(
        {
          seeds: seedPapers.map((paper) => paper.doi || paper.url || paper.title),
          discovered: discovered.map((paper) => paper.doi || paper.url || paper.title),
          note: "Seeds are 0..N-1 and discovered are N..M; use addFromJson with indices.",
        },
        null,
        2
      ),
    };
  }

  addFromJson(params: {
    jsonText: string;
    currentRisText: string;
    indices?: number[];
    doi?: string;
    orderJsonText?: string;
  }): AddPapersResult {
    const data = loadFromJson(params.jsonText);
    let allPapers: Paper[] = [];
    if (Array.isArray(data)) {
      allPapers = data;
    } else if (data instanceof CitationGraph) {
      allPapers = [...data.nodes];
      if (params.orderJsonText) {
        const order = JSON.parse(params.orderJsonText) as { seeds?: string[]; discovered?: string[] };
        const keyMap = new Map(allPapers.map((paper) => [paper.doi || paper.url || paper.title, paper]));
        const seeds = (order.seeds ?? []).map((id) => keyMap.get(id)).filter((paper): paper is Paper => !!paper);
        const discovered = sortPapers(
          (order.discovered ?? []).map((id) => keyMap.get(id)).filter((paper): paper is Paper => !!paper)
        );
        allPapers = [...seeds, ...discovered];
      } else {
        allPapers = sortPapers(allPapers);
      }
    } else {
      allPapers = sortPapers(data.papers);
    }

    let selected: Paper[] = [];
    if (params.indices?.length) {
      selected = params.indices.map((index) => allPapers[index]).filter((paper): paper is Paper => !!paper);
    } else if (params.doi) {
      const target = normalizeDoi(params.doi);
      const one = allPapers.find((paper) => normalizeDoi(paper.doi) === target);
      selected = one ? [one] : [];
    }
    return addPapersToRis(selected, params.currentRisText);
  }

  async fetchPmids(pmids: string[], currentRisText: string, email?: string): Promise<{ risText: string; added: number; skipped: number }> {
    const params = new URLSearchParams({
      db: "pubmed",
      id: pmids.join(","),
      rettype: "nbib",
      retmode: "text",
    });
    if (email) {
      params.set("email", email);
    }
    const response = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params.toString()}`, {
      headers: { "User-Agent": "citation-manager-js/1.0" },
    });
    if (!response.ok) {
      throw new Error(`PMID fetch failed (${response.status})`);
    }
    const nbibText = await response.text();
    return importNbibToRis(nbibText, currentRisText);
  }
}
