import { CitationGraph, Paper, type CitationEdge, type SearchResult } from "./models.js";
import { type Direction, type LiteratureConnector } from "./connectors.js";

export interface EngineOptions {
  connectors: LiteratureConnector[];
}

export interface SearchParams {
  databases?: string[];
  maxPapersPerDatabase?: number;
  since?: Date;
  until?: Date;
}

function mergePapers(papers: Paper[]): Paper[] {
  const byKey = new Map<string, Paper>();
  for (const paper of papers) {
    const key = paper.key();
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, paper);
      continue;
    }
    const merged = new Paper({
      ...current,
      abstract: current.abstract || paper.abstract,
      authors: current.authors.length ? current.authors : paper.authors,
      source: current.source || paper.source,
      publicationDate: (current.publicationDate || paper.publicationDate)?.toISOString(),
      pageRange: current.pageRange || paper.pageRange,
      doi: current.doi || paper.doi,
      url: current.url || paper.url,
      keywords: [...new Set([...current.keywords, ...paper.keywords])],
      citations: Math.max(current.citations ?? 0, paper.citations ?? 0),
      references: [...new Set([...current.references, ...paper.references])],
      databases: [...new Set([...current.databases, ...paper.databases])],
    });
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

export class Engine {
  private readonly connectors: Map<string, LiteratureConnector>;

  constructor(options: EngineOptions) {
    this.connectors = new Map(options.connectors.map((connector) => [connector.id, connector]));
  }

  async search(query: string, params: SearchParams = {}): Promise<SearchResult> {
    const selected = params.databases?.length ? params.databases : [...this.connectors.keys()];
    const papers: Paper[] = [];
    for (const id of selected) {
      const connector = this.connectors.get(id);
      if (!connector) {
        continue;
      }
      const batch = await connector.search(query, {
        maxPapers: params.maxPapersPerDatabase,
        since: params.since,
        until: params.until,
      });
      papers.push(...batch);
    }
    return {
      query,
      databases: selected,
      papers: mergePapers(papers),
    };
  }

  async get(identifier: string): Promise<Paper | null> {
    for (const connector of this.connectors.values()) {
      const paper = await connector.get(identifier);
      if (paper) {
        return paper;
      }
    }
    return null;
  }

  async snowball(
    seedPapers: Paper[],
    options: { maxDepth: number; direction: "both" | Direction; topNPerLevel?: number }
  ): Promise<CitationGraph> {
    const nodeMap = new Map<string, Paper>();
    const edges: CitationEdge[] = [];
    const queue: Array<{ paper: Paper; depth: number }> = seedPapers.map((paper) => ({ paper, depth: 0 }));
    seedPapers.forEach((paper) => nodeMap.set(paper.key(), paper));

    while (queue.length) {
      const next = queue.shift();
      if (!next || next.depth >= options.maxDepth) {
        continue;
      }

      const dirs: Direction[] =
        options.direction === "both" ? ["forward", "backward"] : [options.direction];

      for (const dir of dirs) {
        for (const connector of this.connectors.values()) {
          const neighbors = await connector.neighbors(next.paper, dir, options.topNPerLevel);
          for (const neighbor of neighbors) {
            const key = neighbor.key();
            if (!nodeMap.has(key)) {
              nodeMap.set(key, neighbor);
              queue.push({ paper: neighbor, depth: next.depth + 1 });
            }
            edges.push({
              from: dir === "forward" ? key : next.paper.key(),
              to: dir === "forward" ? next.paper.key() : key,
              relation: dir === "forward" ? "cited_by" : "cites",
            });
          }
        }
      }
    }

    return new CitationGraph([...nodeMap.values()], edges);
  }
}
