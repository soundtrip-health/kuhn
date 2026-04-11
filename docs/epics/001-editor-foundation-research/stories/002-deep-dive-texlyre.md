# Story 002: Deep-Dive: TeXlyre

**Status:** ready
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** L

## Goal

Thoroughly evaluate TeXlyre as a potential editor foundation. Clone the repo, build it, assess code quality, understand the architecture, and determine how extensible it is for our use case.

## Acceptance Criteria

- [ ] Successfully build and run TeXlyre locally
- [ ] Document the tech stack (framework, editor component, build system)
- [ ] Map the architecture — how are editor, compiler, preview connected?
- [ ] Assess code quality: TypeScript coverage, test coverage, documentation
- [ ] Identify extension points — where would slash commands, agent sidebar, and inline results hook in?
- [ ] Document AGPL license implications specifically for our SaaS use case
- [ ] Evaluate Typst support feasibility — how hard to add a second compilation target?
- [ ] Note any red flags (abandoned dependencies, security issues, hard-coded assumptions)

## Notes

- Repo: https://github.com/TeXlyre/texlyre
- AGPL means any network user gets source access rights — this affects our entire deployment model
- Even if AGPL is a dealbreaker for production, the UX patterns may be worth studying
