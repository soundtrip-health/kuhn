import { CitationGraph, Paper, type CitationEdge, type PaperInput, type SearchResult } from "./models.js";

export type SerializablePayload =
  | { type: "search_result"; query: string; databases: string[]; papers: PaperInput[] }
  | { type: "citation_graph"; nodes: PaperInput[]; edges: CitationEdge[] }
  | { type: "papers"; papers: PaperInput[] };

function paperToInput(paper: Paper): PaperInput {
  return {
    id: paper.id,
    paperType: paper.paperType,
    title: paper.title,
    abstract: paper.abstract,
    authors: paper.authors,
    source: paper.source,
    publicationDate: paper.publicationDate?.toISOString(),
    pageRange: paper.pageRange,
    doi: paper.doi,
    url: paper.url,
    keywords: paper.keywords,
    language: paper.language,
    citations: paper.citations,
    references: paper.references,
    databases: paper.databases,
  };
}

function fromInput(input: PaperInput): Paper {
  return new Paper(input);
}

export function saveToJson(value: SearchResult | CitationGraph | Paper[]): string {
  if (Array.isArray(value)) {
    return JSON.stringify(
      {
        type: "papers",
        papers: value.map(paperToInput),
      } satisfies SerializablePayload,
      null,
      2
    );
  }

  if (value instanceof CitationGraph) {
    return JSON.stringify(
      {
        type: "citation_graph",
        nodes: value.nodes.map(paperToInput),
        edges: value.edges,
      } satisfies SerializablePayload,
      null,
      2
    );
  }

  return JSON.stringify(
    {
      type: "search_result",
      query: value.query,
      databases: value.databases,
      papers: value.papers.map(paperToInput),
    } satisfies SerializablePayload,
    null,
    2
  );
}

export function loadFromJson(text: string): SearchResult | CitationGraph | Paper[] {
  const payload = JSON.parse(text) as SerializablePayload;
  if (payload.type === "search_result") {
    return {
      query: payload.query,
      databases: payload.databases,
      papers: payload.papers.map(fromInput),
    };
  }
  if (payload.type === "citation_graph") {
    return new CitationGraph(payload.nodes.map(fromInput), payload.edges);
  }
  return payload.papers.map(fromInput);
}
