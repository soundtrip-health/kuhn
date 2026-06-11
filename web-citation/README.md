# Web Citation Tools (Browser-first)

This module ports the core workflow from `scientific-writing/scripts/citation_manager.py` into browser-friendly TypeScript:

- `rispy-js`: RIS parse + dump
- `findpapers-js`: paper models, persistence, and search/snowball engine
- `citation-manager`: high-level workflow methods for RIS maintenance

## Install

```bash
cd scientific-writing/web-citation
npm install typescript --save-dev
npm run check
```

## Usage

```ts
import {
  CitationManager,
  Engine,
  OpenAlexConnector,
  CrossrefConnector,
  SemanticScholarConnector,
  addPapersToRis,
} from "./src/index.js";

const engine = new Engine({
  connectors: [
    new OpenAlexConnector("you@example.com"),
    new CrossrefConnector("you@example.com"),
    new SemanticScholarConnector("<optional-api-key>"),
  ],
});

const manager = new CitationManager(engine);

const { result, json } = await manager.search({
  query: "transformer model interpretability",
  databases: ["openalex", "crossref", "semantic_scholar"],
  maxPerDatabase: 25,
});

// Add selected papers to RIS text in app state.
const selected = result.papers.slice(0, 3);
const update = addPapersToRis(selected, currentRisText);
currentRisText = update.risText;
```

## Notes for in-browser deployment

- CORS differs by provider; a backend proxy may still be needed for some APIs.
- API keys should not be hard-coded in frontend bundles.
- RIS and JSON persistence are string-based so you can store them in IndexedDB, localStorage, or synced app state.
