export { Engine, type EngineOptions, type SearchParams } from "./engine.js";
export {
  OpenAlexConnector,
  CrossrefConnector,
  SemanticScholarConnector,
  type Direction,
  type SearchOptions,
  type LiteratureConnector,
} from "./connectors.js";
export { Paper, CitationGraph, type PaperType, type Author, type Source, type SearchResult } from "./models.js";
export { loadFromJson, saveToJson } from "./persistence.js";
