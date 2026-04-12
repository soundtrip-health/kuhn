# Story 001: Survey Candidate Projects

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** M

## Goal

Identify viable open-source browser-based LaTeX/Typst editor projects and produce a comparison matrix covering the decision factors for Kuhn.

## Acceptance Criteria

- [x] At least 5 candidates identified and briefly evaluated
- [x] Comparison matrix created covering: license, features, Typst support, extensibility, compilation model, community activity
- [x] Known candidates include: TeXlyre, BusyIDE/BusyTeX, Overleaf CE, SwiftLaTeX, and any others found
- [x] Also evaluate "build from primitives" approach (CodeMirror 6 + custom)
- [x] Top 2-3 candidates identified for deeper investigation

## Survey Summary

The candidate set splits into three practical categories:

1. Full product we could adopt or fork: TeXlyre, BusyIDE, Overleaf CE
2. Technology substrate rather than full product: SwiftLaTeX, BusyTeX
3. Purpose-built foundation assembled by us: CodeMirror 6 + custom compilation and preview pipeline

For Kuhn's requirements, the strongest options are:

1. **Build from primitives** for the long-term product foundation
2. **BusyIDE / BusyTeX** as the most permissive existing reference implementation and possible spike target
3. **TeXlyre** as the best UX and Typst reference, but not a production foundation because of AGPL risk

## Comparison Matrix

| Candidate | License | Browser Editing / Preview | Typst Support | Extensibility for Agents | Compilation Model | Community / Maintenance Snapshot | Initial Read |
|---|---|---|---|---|---|---|---|
| [TeXlyre](https://github.com/TeXlyre/texlyre) | AGPL-3.0 | Strong editor UX, real-time collaboration, offline-first, PDF preview | Native Typst support called out in repo description | Good architectural fit on paper; modern TypeScript stack should be easier to extend than older monoliths | Client-side/WASM for both LaTeX and Typst, built on SwiftLaTeX + typst.ts | ~482 stars, 22 forks, 2 contributors; GitHub topic page showed updated **2025-11-20** | Excellent product reference, weak licensing fit |
| [BusyIDE](https://github.com/busytex/busyide) + [BusyTeX](https://github.com/busytex/busytex) | MIT | Basic but real browser IDE, syntax highlighting, preview, GitHub integration, BibTeX, multiple LaTeX engines | No native Typst support visible | Hackable by design; repo explicitly emphasizes small codebase and "high hackability" | Fully client-side; BusyTeX compiles TeX Live programs to WASM | BusyIDE ~14 stars / 1 fork / 1,609 commits; BusyTeX ~66 stars / 8 forks / 1,962 commits | Best permissive full-stack spike target, but product polish is low |
| [Overleaf Community Edition](https://github.com/overleaf/overleaf) | AGPL-3.0 | Mature collaborative LaTeX editor with broad feature coverage | No Typst support | Large, service-heavy architecture; extensibility likely possible but costly | Server-side compile and services | ~17k stars, 1.8k forks; community/deployment docs active in 2025 | Strongest feature set, worst fit for product/control complexity |
| [SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX) | Apache-2.0 | In-browser LaTeX compilation substrate rather than complete product | No Typst support | Useful building block, not enough UX by itself | WASM LaTeX engine | GitHub org listing showed repo updated **2024-06-18** | Good component, not sufficient as the app foundation |
| Build from primitives: CodeMirror 6 + custom preview/compiler adapters | Our choice | Exactly what we build | Typst can be designed in from the start | Best fit; we can design slash commands, sidebar, inline insertions, and agent streaming as first-class features | Server-side, WASM, or hybrid | No inherited community; highest implementation burden | Best long-term product fit if we accept more upfront engineering |

## Candidate Notes

### TeXlyre

- Best match for the product vision: local-first, collaborative, LaTeX + Typst, modern web UX.
- The licensing cost is likely fatal for a closed-source or source-available commercial SaaS unless we negotiate a separate commercial arrangement.
- Even if we do not adopt it, it is worth studying for UX patterns and Typst integration strategy.

### BusyIDE / BusyTeX

- Much smaller and more direct than Overleaf or TeXlyre.
- The README is unusually candid about trade-offs: it calls out missing SyncTeX, lack of automated functional testing, Safari/mobile gaps, and UI cleanup still needed.
- The upside is that those same constraints make it easier to understand where a slash-command spike would hook in.

### Overleaf CE

- The benchmark for collaborative LaTeX editing, but operationally large and license-constrained.
- Its own README warns Community Edition is intended for trusted users and lacks sandboxed compiles by default, which is a poor default for a multi-user agent product.
- Good benchmark for workflow expectations, not the right base to own.

### SwiftLaTeX

- Best understood as a dependency candidate for client-side LaTeX compilation, not a full editor foundation.
- It helps the "build from primitives" path more than the "adopt an existing app wholesale" path.

### Build From Primitives

- This is the only option that cleanly aligns with:
  - permissive licensing,
  - first-class agent UX,
  - clean support for both LaTeX and Typst,
  - and the ability to choose server-side, WASM, or hybrid compilation separately from the editor shell.
- The cost is straightforward: more initial implementation and more responsibility for document UX.

## Shortlist For Deeper Investigation

### 1. Build from primitives

Primary recommendation for product architecture. We should validate effort and extension ergonomics with a small editor shell spike.

### 2. BusyIDE / BusyTeX

Best permissive existing codebase to spike against. If a `/hello` command is easy here, we gain an existence proof for integrating commands into an editor that already compiles in-browser.

### 3. TeXlyre

Worth deep-diving as a reference implementation and fallback if licensing posture changes. It should inform UX and architecture, but not be assumed deployable as our foundation.

## Sources

- [TeXlyre repository](https://github.com/TeXlyre/texlyre)
- [BusyIDE repository](https://github.com/busytex/busyide)
- [BusyTeX repository](https://github.com/busytex/busytex)
- [Overleaf Community Edition repository](https://github.com/overleaf/overleaf)
- [SwiftLaTeX organization](https://github.com/SwiftLaTeX)
