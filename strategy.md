# Commercialization Strategy

> **Revised 2026-06-11.** The original version of this document was an AGPL compliance strategy
> for building on a TeXlyre (AGPL-3.0) fork. With the move to a Milkdown-based editor (MIT) —
> see [docs/architecture.md](docs/architecture.md) — the AGPL apparatus (public fork obligation,
> license firewall, legally mandated app split) no longer applies. Git history has the old text.

## 1. Licensing Posture

The entire frontend stack (Milkdown, ProseMirror, remark, Yjs) is MIT/permissive. There is no
copyleft obligation anywhere in the product:

| Component | License | Visibility |
| :--- | :--- | :--- |
| Editor frontend (Milkdown/ProseMirror) | MIT deps | Our code: proprietary or open at our choice |
| Agent backend, runtime, orchestration | Proprietary | Private |
| Agent prompts & curated guidance corpus | Proprietary | Private |
| Typst / Pandoc toolchain | Apache-2.0 / GPL (invoked as separate processes) | Upstream |

Note: Pandoc is GPL but is invoked as a standalone process, not linked — standard practice, no
copyleft implications for our code.

## 2. Service Boundaries (kept as engineering practice)

The clean API boundary between editor surface and agent intelligence remains — not for license
compliance, but because it is good architecture and supports diligence:

- The frontend talks to the backend through documented, versioned APIs (the agent-task interface).
- Proprietary value (agents, prompts, orchestration, curated guidance corpus, retrieval, billing)
  lives behind that API.
- The agent-task boundary also hedges LLM-provider lock-in (see architecture.md).

## 3. Business Model

- **Product:** hosted scientific-writing workspace; the AI agents are the value, the editor is
  the surface.
- **Moats:** agent quality (prompts, orchestration, domain workflows), the curated shared
  guidance corpus (FDA/ICH/NIH/journal guidance, maintained editorially), and per-tenant
  knowledge bases that compound for the customer.
- **Trust posture for the target market** (clinical/regulatory/grant writers): per-tenant data
  isolation, no cross-tenant training or leakage, clear answers on BAA/SOC2 when asked. This is
  a sales requirement, not a feature (see Multi-Tenancy Invariants in architecture.md).
- **Open-source posture:** optional, strategic. We may open generic Milkdown plugins (e.g., a
  citation plugin) for community goodwill — by choice, not obligation.

## 4. Investor Readiness

- Clear diagram: MIT editor surface / proprietary intelligence behind a versioned API.
- No AGPL exposure to explain away in diligence.
- IP concentrated in the backend: prompts, orchestration, corpus, eval data.
