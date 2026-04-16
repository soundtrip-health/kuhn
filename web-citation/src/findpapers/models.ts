export type PaperType =
  | "article"
  | "inproceedings"
  | "inbook"
  | "incollection"
  | "book"
  | "phdthesis"
  | "mastersthesis"
  | "techreport"
  | "unpublished"
  | "misc";

export interface Author {
  name: string;
}

export interface Source {
  id?: string;
  title: string;
  publisher?: string;
}

export interface PaperInput {
  id?: string;
  paperType?: PaperType;
  title: string;
  abstract?: string;
  authors?: Author[];
  source?: Source;
  publicationDate?: string;
  pageRange?: string;
  doi?: string;
  url?: string;
  keywords?: string[];
  language?: string;
  citations?: number;
  references?: string[];
  databases?: string[];
}

export class Paper {
  readonly id?: string;
  readonly paperType: PaperType;
  readonly title: string;
  readonly abstract?: string;
  readonly authors: Author[];
  readonly source?: Source;
  readonly publicationDate?: Date;
  readonly pageRange?: string;
  readonly doi?: string;
  readonly url?: string;
  readonly keywords: string[];
  readonly language?: string;
  readonly citations?: number;
  readonly references: string[];
  readonly databases: string[];

  constructor(input: PaperInput) {
    this.id = input.id;
    this.paperType = input.paperType ?? "misc";
    this.title = input.title;
    this.abstract = input.abstract;
    this.authors = input.authors ?? [];
    this.source = input.source;
    this.publicationDate = input.publicationDate ? new Date(input.publicationDate) : undefined;
    this.pageRange = input.pageRange;
    this.doi = input.doi;
    this.url = input.url;
    this.keywords = input.keywords ?? [];
    this.language = input.language;
    this.citations = input.citations;
    this.references = input.references ?? [];
    this.databases = input.databases ?? [];
  }

  key(): string {
    return (this.doi || this.url || this.id || this.title).trim().toLowerCase();
  }
}

export interface SearchResult {
  papers: Paper[];
  query: string;
  databases: string[];
}

export interface CitationEdge {
  from: string;
  to: string;
  relation: "cites" | "cited_by";
}

export class CitationGraph {
  readonly nodes: Paper[];
  readonly edges: CitationEdge[];

  constructor(nodes: Paper[], edges: CitationEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
  }
}
