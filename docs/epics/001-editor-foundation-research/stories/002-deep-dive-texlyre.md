# Story 002: Deep-Dive: TeXlyre

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** L

## Goal

Thoroughly evaluate TeXlyre as a potential editor foundation. Clone the repo, build it, assess code quality, understand the architecture, and determine how extensible it is for our use case.

## Acceptance Criteria

- [x] Successfully build and run TeXlyre locally
- [x] Document the tech stack (framework, editor component, build system)
- [x] Map the architecture — how are editor, compiler, preview connected?
- [x] Assess code quality: TypeScript coverage, test coverage, documentation
- [x] Identify extension points — where would slash commands, agent sidebar, and inline results hook in?
- [x] Document AGPL license implications specifically for our SaaS use case
- [x] Evaluate Typst support feasibility — how hard to add a second compilation target?
- [x] Note any red flags (abandoned dependencies, security issues, hard-coded assumptions)

## Resolution

This story was completed implicitly through Epic 003 (TeXlyre Citation Assistant), which went far beyond a deep-dive: we forked TeXlyre, built and ran it locally, mapped extension points, and implemented a full `/cite` slash command with grounded retrieval. The AGPL license analysis was completed in Story 004.

Key findings from the hands-on work in Epic 003:

- **Tech stack:** React + TypeScript, CodeMirror 6, Vite build system
- **Architecture:** Client-side compilation (SwiftLaTeX WASM for LaTeX, typst.ts for Typst), PDF/Canvas preview, Yjs for collaboration
- **Extension points:** Service-based architecture in `src/services/` made slash command integration straightforward — `/cite` hooked into the editor via CodeMirror extensions
- **Typst:** Native support already present
- **Code quality:** Well-structured, modern TypeScript; suitable as a foundation
- **AGPL:** Documented in Story 004; manageable via open-core strategy (see `strategy.md`)

## Notes

- Repo: https://github.com/TeXlyre/texlyre
- AGPL means any network user gets source access rights — this affects our entire deployment model
- The hands-on experience from Epic 003 was far more informative than a read-only deep-dive would have been
