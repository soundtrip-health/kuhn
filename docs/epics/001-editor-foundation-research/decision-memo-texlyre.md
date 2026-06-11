# Decision Memo: TeXlyre Open-Core Path

**Date:** 2026-04-11
**Status:** Draft
**Scope:** Editor foundation decision for Kuhn

## Decision

Kuhn will proceed on the assumption that **TeXlyre is the editor foundation**, with an **open-core architecture**:

- the TeXlyre-derived editor layer is public and AGPL-compliant,
- Kuhn-specific editor modifications are maintained in a public fork or upstreamed,
- and proprietary agent services remain separate networked systems behind a stable API boundary.

This is a product and licensing decision, not just a technical preference.

## Why This Path

- TeXlyre is the closest match to Kuhn's target user experience.
- It already supports the core document modes we care about: LaTeX and Typst.
- Adopting it reduces time spent rebuilding mature editor UX from scratch.
- The open-core trade is acceptable if we are deliberate about what stays in the public editor layer and what remains proprietary.

## What Must Be Public

Developers should assume the following belong in the AGPL/public layer:

- editor UI and workflow code,
- slash-command surfaces and invocation plumbing,
- client-side document interactions,
- API client code that calls backend services,
- local or browser-side helper models/features shipped in the editor,
- and any changes to TeXlyre itself or tightly integrated editor extensions.

If code is needed for the browser/editor experience to function, default to assuming it belongs in the public layer unless there is a strong reason otherwise.

## What Can Remain Proprietary

The following can remain private if they are implemented as genuinely separate services:

- hosted AI agent runtimes,
- orchestration logic across agents,
- prompts, internal policies, ranking logic, and evaluation systems,
- private retrieval/indexing infrastructure,
- billing, tenancy, quotas, and hosted operations tooling,
- and backend services that are useful independently of the AGPL editor.

The key test is separation: these systems should be deployable, evolvable, and describable as standalone services reached over a normal network API.

## Architecture Rules For Developers

### 1. Treat the editor/backend boundary as a hard product boundary

- Use explicit REST, WebSocket, or gRPC APIs.
- Keep browser/editor code out of proprietary service repos.
- Do not share internal application modules across the AGPL editor and proprietary backend.

### 2. Do not hide core editor behavior in the backend

- Slash-command triggering, UI affordances, and insertion workflows belong in the public editor layer.
- The backend may compute results, but the editor-side integration logic should remain public.

### 3. Avoid tight coupling that weakens the separation story

- Do not build private backend logic that depends on undocumented in-process hooks inside the editor.
- Prefer versioned public APIs over shared internals.
- If a backend feature requires custom editor protocol behavior, document that protocol clearly and treat the client implementation as public.

### 4. Keep proprietary value in services, data, and operations

- Competitive advantage should live in model quality, orchestration, domain workflows, retrieval quality, reliability, and hosted execution.
- Do not assume the UI layer itself is proprietary IP.

### 5. Design for upstreaming when practical

- If we modify TeXlyre in a generally useful way, prefer upstream contributions.
- This reduces fork maintenance and makes AGPL compliance easier to manage.

### 6. Write docs as if they may be reviewed during diligence

- Maintain clean architecture diagrams.
- Document which repos are public and which are private.
- Be able to explain, in one page, why the backend services are separate systems rather than concealed editor code.

## Anti-Patterns To Avoid

- Putting proprietary business logic directly into the TeXlyre fork.
- Sharing source files, packages, or internal libraries between the AGPL editor and private backend.
- Designing backend APIs that only work through hidden editor-specific behavior with no clean external contract.
- Treating AGPL obligations as something to clean up later.
- Assuming that "API boundary" language by itself solves poor separation.

## Immediate Engineering Implications

- Create a public TeXlyre fork early if this path is confirmed.
- Define the agent API surface before deep editor customization.
- Keep command parsing and UI invocation logic in the public repo.
- Keep backend agent execution, policy, and orchestration in private services.
- Review new editor features by asking: "Does this belong to the public product shell or the private service layer?"

## Open Questions

- Do we want to upstream most editor extensions, or maintain a long-lived public fork?
- Which slash-command semantics belong in the editor versus the backend?
- How much local/offline intelligence do we want to ship in the browser, knowing that code will be public?
- Do we want one public repo or multiple public repos for the editor/client layer?

## Summary

TeXlyre is viable for Kuhn if we are explicit that the editor layer is open and the proprietary value lives in separate services. The architecture must be designed around that fact from day one. If the team is not comfortable with that posture, TeXlyre should not be the foundation.
