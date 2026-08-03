# Story 006: Recommendation & Decision

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** M

## Goal

Synthesize findings from the editor-foundation research into a recommendation document. Present trade-offs clearly enough to guide the next spike and architecture work.

## Acceptance Criteria

- [x] Recommendation document written covering:
  - Summary of each candidate's strengths and weaknesses
  - License implications and risk assessment
  - Extensibility assessment based on the current evidence
  - Estimated effort to reach MVP for each approach
  - Clear recommendation with reasoning
- [x] Decision made and recorded
- [x] Architecture doc (`docs/architecture.md`) updated to reflect the chosen foundation
- [x] Follow-on epics drafted based on the decision

## Recommendation

### Proposed Decision

Adopt **a custom editor foundation built from primitives**, centered on:

- CodeMirror 6 for editing,
- a dedicated preview pane and compilation service abstraction,
- LaTeX and Typst adapters behind a shared document model,
- and first-class slash-command / agent integration owned by Kuhn.

This should be treated as the default product path unless the spike work disproves the expected extension ergonomics.

### Strategic Alternative

If Kuhn wants an **open-core** posture, there is a second legitimate path:

- adopt TeXlyre as the public AGPL editor layer,
- keep Kuhn-specific editor modifications in a public fork,
- and place proprietary agent logic, prompts, and hosted orchestration behind a clean network boundary.

That is a business-model choice, not a pure engineering optimization.

### Why this is the strongest option

#### 1. It matches the product shape

Kuhn is not just "a LaTeX editor with AI bolted on." The editor itself is the agent surface:

- slash commands,
- inline result insertion,
- selection-aware workflows,
- agent panel coordination,
- and terminal/document interactions.

Those requirements push us toward owning the interaction model rather than adapting to an existing product's assumptions.

#### 2. It avoids strategic license risk

- TeXlyre and Overleaf CE are both AGPL-licensed.
- They may be excellent software, but the editor shell is too central to Kuhn's proprietary UX to place under a copyleft cloud.
- A permissive foundation lets us move quickly without turning architecture into a compliance exercise.
- This point weakens if the company explicitly wants an open-core editor strategy.

#### 3. It separates editor UX from compilation strategy

With a custom foundation, we can choose compilation per target:

- server-side for consistency and package completeness,
- WASM for low-latency or offline scenarios,
- or hybrid per document type and environment.

That flexibility is hard to preserve if we inherit an app whose editor and compiler are already tightly coupled.

## Options Compared

### Option A: Build from primitives

Strengths:

- Best extensibility
- Clean licensing
- Typst can be designed in instead of retrofitted
- Clean separation between editor, compile service, and agent layer

Weaknesses:

- Highest initial engineering investment
- We must build baseline document UX ourselves

Estimated effort to MVP:

- **Medium-high**, but the work directly builds product assets instead of paying integration tax into someone else's architecture.

### Option B: BusyIDE / BusyTeX

Strengths:

- Permissive MIT license
- Real working browser IDE already exists
- Small codebase makes spikes cheap

Weaknesses:

- Product polish is far behind our target
- Typst support is absent
- We would likely outgrow its architecture quickly if the product succeeds

Estimated effort to MVP:

- **Medium** for a spike, **medium-high** for product hardening because substantial UX and architecture work would still be required.

### Option C: TeXlyre

Strengths:

- Closest to our desired end-user experience
- Already supports both LaTeX and Typst
- Modern stack and collaboration model
- Could support an open-core commercialization model if we are willing to keep the editor layer public

Weaknesses:

- AGPL risk is the central blocker
- Forking deeply into the editor would place our most valuable UX work in the highest-risk licensing area
- The product team would need discipline around public/private boundaries from day one

Estimated effort to MVP:

- **Low-medium technically**, **high strategically** because of licensing.

### Option D: Overleaf CE

Strengths:

- Richest mature feature set
- Proven LaTeX workflow

Weaknesses:

- AGPL
- Large operational footprint
- Typst gap
- More service platform than editor foundation

Estimated effort to MVP:

- **High**, because adopting it would mean inheriting operational and architectural complexity we do not want.

## Extensibility Read Before The Spike

Even before Story 005 is complete, the likely pattern is clear:

- **Build from primitives** is most likely to make slash commands feel native.
- **BusyIDE** is the best permissive environment for a quick `/hello` proof-of-concept.
- **TeXlyre** is worth studying for interaction design, but not for product adoption.

That means Story 005 should focus on:

1. A tiny custom CodeMirror shell owned by Kuhn
2. BusyIDE as the comparison spike

TeXlyre can remain a read-only architectural reference unless we later decide licensing is negotiable.

## Final Decision (Recorded 2026-04-17)

**Decision: Adopt TeXlyre as the editor foundation under an open-core strategy.**

The original engineering recommendation was to build from primitives. That recommendation was sound on licensing grounds, but the project chose the strategic alternative documented above: TeXlyre as the public AGPL editor layer, with proprietary agent logic behind a clean network boundary.

### What changed

Epic 003 (TeXlyre Citation Assistant) served as both an extensibility spike and a deep-dive. The hands-on experience demonstrated that:

1. **TeXlyre's architecture is extensible.** The `/cite` slash command integrated naturally via CodeMirror 6 extensions and the service layer. No core internals needed invasive modification.
2. **The product fit is strong.** TeXlyre already supports both LaTeX and Typst, has collaboration via Yjs, and provides a modern UX close to our target.
3. **The open-core model is viable.** The AGPL commercialization strategy is documented in `strategy.md`. Editor-layer customizations are public; agent intelligence, prompts, and orchestration remain proprietary behind an API boundary.

### Follow-on epics

- **Epic 002 (Agent Orchestration Layer)** — already in progress, building the proprietary backend that sits behind the editor
- **Epic 003 (Citation Assistant)** — completed, the first agent integration on the TeXlyre foundation

### Risks accepted

- AGPL compliance overhead for editor-layer modifications (mitigated by public fork strategy)
- Fork maintenance burden if upstream TeXlyre diverges significantly
- Transitive dependency license audit still outstanding (tracked but not a blocker)

## Notes

- The "build from primitives" path remains a valid fallback if the open-core posture proves untenable.
- See [AGPL commercialization strategy](../../../../strategy.md) for the architectural boundary guidelines.
- See `docs/architecture.md` for the updated system architecture.
