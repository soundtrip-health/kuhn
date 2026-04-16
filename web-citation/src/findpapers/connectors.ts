import { Paper, type Author, type PaperInput } from "./models.js";

export type Direction = "forward" | "backward";

export interface SearchOptions {
  maxPapers?: number;
  since?: Date;
  until?: Date;
}

export interface LiteratureConnector {
  readonly id: string;
  search(query: string, options?: SearchOptions): Promise<Paper[]>;
  get(identifier: string): Promise<Paper | null>;
  neighbors(paper: Paper, direction: Direction, topN?: number): Promise<Paper[]>;
}

function parseDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function normalizeAuthors(items: unknown[]): Author[] {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const raw = item as Record<string, unknown>;
      const displayName = (raw.display_name || raw.name || "").toString().trim();
      if (!displayName) {
        return null;
      }
      return { name: displayName };
    })
    .filter((author): author is Author => !!author);
}

function normalizeDoi(doi?: string): string | undefined {
  if (!doi) {
    return undefined;
  }
  return doi.replace("https://doi.org/", "").trim();
}

function openAlexToPaper(raw: Record<string, unknown>): Paper {
  const authorships = Array.isArray(raw.authorships) ? raw.authorships : [];
  const authors = authorships
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).author : null))
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((author) => ({ name: String(author.display_name ?? "").trim() }))
    .filter((author) => author.name.length > 0);

  const source = raw.primary_location && typeof raw.primary_location === "object"
    ? (raw.primary_location as Record<string, unknown>).source
    : undefined;
  const sourceObj = source && typeof source === "object"
    ? {
        id: String((source as Record<string, unknown>).id ?? ""),
        title: String((source as Record<string, unknown>).display_name ?? ""),
      }
    : undefined;

  const input: PaperInput = {
    id: String(raw.id ?? ""),
    paperType: "article",
    title: String(raw.title ?? ""),
    abstract: undefined,
    authors,
    source: sourceObj?.title ? sourceObj : undefined,
    publicationDate: parseDate(String(raw.publication_date ?? "")),
    doi: normalizeDoi(String(raw.doi ?? "")),
    url: String(raw.id ?? ""),
    citations: Number(raw.cited_by_count ?? 0),
    references: Array.isArray(raw.referenced_works) ? raw.referenced_works.map(String) : [],
    databases: ["openalex"],
  };
  return new Paper(input);
}

export class OpenAlexConnector implements LiteratureConnector {
  readonly id = "openalex";

  constructor(private readonly email?: string) {}

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const max = options.maxPapers ?? 25;
    const params = new URLSearchParams({
      search: query,
      per_page: String(Math.min(max, 200)),
    });
    if (this.email) {
      params.set("mailto", this.email);
    }
    const response = await fetch(`https://api.openalex.org/works?${params.toString()}`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { results?: Record<string, unknown>[] };
    return (data.results ?? []).map(openAlexToPaper).slice(0, max);
  }

  async get(identifier: string): Promise<Paper | null> {
    const normalized = identifier.startsWith("10.") ? `https://doi.org/${identifier}` : identifier;
    const params = new URLSearchParams({
      filter: `doi:${normalized}`,
      per_page: "1",
    });
    if (this.email) {
      params.set("mailto", this.email);
    }
    const response = await fetch(`https://api.openalex.org/works?${params.toString()}`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { results?: Record<string, unknown>[] };
    const first = data.results?.[0];
    return first ? openAlexToPaper(first) : null;
  }

  async neighbors(paper: Paper, direction: Direction, topN?: number): Promise<Paper[]> {
    if (direction === "backward" && paper.references.length > 0) {
      const candidates = paper.references.slice(0, topN ?? 20);
      const out: Paper[] = [];
      for (const ref of candidates) {
        const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(ref)}`);
        if (!response.ok) {
          continue;
        }
        const data = (await response.json()) as Record<string, unknown>;
        out.push(openAlexToPaper(data));
      }
      return out;
    }

    const filter = paper.doi ? `cites:https://doi.org/${paper.doi}` : paper.id ? `cites:${paper.id}` : "";
    if (!filter) {
      return [];
    }
    const params = new URLSearchParams({
      filter,
      per_page: String(Math.min(topN ?? 20, 200)),
    });
    if (this.email) {
      params.set("mailto", this.email);
    }
    const response = await fetch(`https://api.openalex.org/works?${params.toString()}`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { results?: Record<string, unknown>[] };
    return (data.results ?? []).map(openAlexToPaper);
  }
}

function crossrefToPaper(raw: Record<string, unknown>): Paper {
  const authorList = Array.isArray(raw.author) ? normalizeAuthors(raw.author) : [];
  const title = Array.isArray(raw.title) ? String(raw.title[0] ?? "") : String(raw.title ?? "");
  const sourceTitle = Array.isArray(raw["container-title"]) ? String(raw["container-title"][0] ?? "") : "";
  return new Paper({
    paperType: "article",
    title,
    authors: authorList,
    source: sourceTitle ? { title: sourceTitle, publisher: String(raw.publisher ?? "") } : undefined,
    publicationDate: parseDate(String(raw.created && typeof raw.created === "object" ? (raw.created as Record<string, unknown>)["date-time"] : "")),
    doi: String(raw.DOI ?? ""),
    url: Array.isArray(raw.URL) ? String(raw.URL[0] ?? "") : String(raw.URL ?? ""),
    citations: Number(raw["is-referenced-by-count"] ?? 0),
    databases: ["crossref"],
  });
}

export class CrossrefConnector implements LiteratureConnector {
  readonly id = "crossref";

  constructor(private readonly mailto?: string) {}

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const max = options.maxPapers ?? 25;
    const params = new URLSearchParams({
      query,
      rows: String(Math.min(max, 100)),
    });
    if (this.mailto) {
      params.set("mailto", this.mailto);
    }
    const response = await fetch(`https://api.crossref.org/works?${params.toString()}`);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { message?: { items?: Record<string, unknown>[] } };
    return (data.message?.items ?? []).map(crossrefToPaper).slice(0, max);
  }

  async get(identifier: string): Promise<Paper | null> {
    const doi = identifier.replace("https://doi.org/", "").trim();
    if (!doi.startsWith("10.")) {
      return null;
    }
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { message?: Record<string, unknown> };
    if (!data.message) {
      return null;
    }
    return crossrefToPaper(data.message);
  }

  async neighbors(_paper: Paper, _direction: Direction): Promise<Paper[]> {
    return [];
  }
}

function semanticScholarToPaper(raw: Record<string, unknown>): Paper {
  return new Paper({
    id: String(raw.paperId ?? ""),
    paperType: "article",
    title: String(raw.title ?? ""),
    abstract: String(raw.abstract ?? ""),
    authors: normalizeAuthors(Array.isArray(raw.authors) ? raw.authors : []),
    publicationDate: parseDate(String(raw.year ?? "")),
    doi: normalizeDoi(String(raw.externalIds && typeof raw.externalIds === "object" ? (raw.externalIds as Record<string, unknown>).DOI ?? "" : "")),
    url: String(raw.url ?? ""),
    citations: Number(raw.citationCount ?? 0),
    databases: ["semantic_scholar"],
  });
}

export class SemanticScholarConnector implements LiteratureConnector {
  readonly id = "semantic_scholar";

  constructor(private readonly apiKey?: string) {}

  private headers(): HeadersInit {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const limit = options.maxPapers ?? 25;
    const params = new URLSearchParams({
      query,
      limit: String(Math.min(limit, 100)),
      fields: "paperId,title,abstract,authors,year,url,citationCount,externalIds",
    });
    const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { data?: Record<string, unknown>[] };
    return (data.data ?? []).map(semanticScholarToPaper);
  }

  async get(identifier: string): Promise<Paper | null> {
    const encoded = encodeURIComponent(identifier);
    const params = new URLSearchParams({
      fields: "paperId,title,abstract,authors,year,url,citationCount,externalIds",
    });
    const response = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${encoded}?${params.toString()}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    return semanticScholarToPaper(data);
  }

  async neighbors(paper: Paper, direction: Direction, topN?: number): Promise<Paper[]> {
    const id = paper.id || paper.doi;
    if (!id) {
      return [];
    }
    const endpoint = direction === "forward" ? "citations" : "references";
    const params = new URLSearchParams({
      limit: String(Math.min(topN ?? 20, 100)),
      fields: "paperId,title,abstract,authors,year,url,citationCount,externalIds",
    });
    const response = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}/${endpoint}?${params.toString()}`,
      { headers: this.headers() }
    );
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { data?: Record<string, unknown>[] };
    return (data.data ?? [])
      .map((entry) => (entry.citedPaper || entry.citingPaper || entry) as Record<string, unknown>)
      .map(semanticScholarToPaper);
  }
}
