# Story 004: License Analysis

**Status:** done
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** M

## Goal

Produce a clear analysis of the licensing implications for each candidate, specifically for Kuhn's planned distribution model: hosted SaaS first, with a possible self-hosted offering later.

## Acceptance Criteria

- [x] AGPL implications documented: what obligations does it create for our codebase?
- [x] MIT/Apache 2.0 implications documented for comparison
- [x] Analyze whether AGPL components can be isolated (e.g., AGPL editor in an iframe, MIT backend)
- [ ] Check all transitive dependencies of top candidates for license conflicts
- [ ] Document any dual-licensing or commercial license options available
- [x] Produce a clear recommendation on which licenses are acceptable

## Executive Read

For Kuhn, **MIT / BSD / Apache-2.0 foundations are acceptable** and **AGPL foundations should be treated as unacceptable by default** unless we explicitly choose to open-source the relevant service or negotiate a separate commercial license.

That conclusion is not about ideology. It is about product control:

- Kuhn is intended to be a hosted webapp with proprietary agent integration and workflow logic.
- An AGPL foundation in the critical webapp path creates a real risk that our modifications and tightly coupled surrounding code become subject to source-disclosure obligations for network users.
- Even where legal isolation might be arguable, it would create ongoing architecture and compliance overhead in the most strategic part of the product.

This is an engineering recommendation, not legal advice. If Kuhn intentionally pursues an open-core business model, the conclusion changes: AGPL can be workable, but only if we are comfortable making the editor-facing layer public by design.

## License-by-License Analysis

### AGPL-3.0

Projects in scope:

- TeXlyre
- Overleaf Community Edition

Implications for Kuhn:

- AGPL is materially different from MIT/Apache in a SaaS context because distribution is not the only trigger we care about.
- If we modify and deploy an AGPL-covered application as part of the service, remote users may be entitled to the corresponding source for that covered work.
- The practical risk is highest when the AGPL component is the editor shell itself, because that is where Kuhn's differentiated UX, slash commands, inline agent interactions, and document workflow would live.

Operational consequences:

- Every non-trivial UI customization needs license review.
- Product boundaries become legal boundaries, not just technical ones.
- Future refactors get constrained by the need to preserve separation arguments.

### MIT

Projects in scope:

- BusyIDE
- BusyTeX

Implications for Kuhn:

- MIT is straightforward for both SaaS and self-hosted distribution.
- We can fork, modify, embed, and redistribute with attribution and preservation of the license notice.
- This is the lowest-friction option for a product that expects significant customization.

### Apache-2.0

Projects in scope:

- SwiftLaTeX

Implications for Kuhn:

- Also acceptable for Kuhn.
- Similar operational freedom to MIT, with explicit patent protections that are generally favorable for commercial products.
- No SaaS copyleft concern.

## Can We Isolate AGPL Components?

Short answer: **possibly in theory, weak in practice**.

Architectural isolation patterns people often consider:

- hosting the AGPL editor as a separate service,
- embedding it via iframe,
- keeping proprietary agent logic on a separate backend,
- or treating the AGPL app as an unmodified upstream dependency.

Why this is still unattractive:

- Our planned value proposition requires deep editor integration: slash commands, inline insertions, agent panel coordination, preview interactions, and terminal workflows.
- Those features push us toward modifying the editor directly or creating a tightly coupled combined experience.
- The more tightly integrated the experience becomes, the less confidence we should have in any "firewall" argument as a product strategy.

Engineering conclusion:

- "AGPL firewall" is not a foundation strategy for Kuhn.
- At most, AGPL products should be treated as reference implementations, research inputs, or temporary internal prototypes.

## Open-Core Alternative

There is one credible path where AGPL is not a blocker: Kuhn could deliberately structure itself as an **open-core product**.

That would look roughly like this:

- a public AGPL fork for the editor shell and API-facing integration points,
- a stable network API boundary between editor and backend services,
- proprietary hosted agent services, orchestration, prompts, and operations behind that boundary,
- and a product story where customers understand that the editor tier is open while the intelligence tier is paid/proprietary.

That approach may be commercially viable, but it changes the product strategy in a material way:

- editor customizations become public,
- upstreaming and fork maintenance become part of the roadmap,
- investor and diligence conversations need a crisp IP-boundary story,
- and we must be comfortable that some portion of the user-visible product is intentionally open.

So the real decision is not just "Is AGPL legal enough?" It is "Do we want Kuhn to be open-core at the editor layer?"

## Self-Hosted Considerations

If Kuhn later ships a self-hosted edition:

- MIT/Apache foundations remain clean and commercially flexible.
- AGPL foundations would force us to decide whether the self-hosted product is open by design or separately licensed.
- Making that trade at the editor-foundation layer is premature and avoidable.

## Known Gaps

- We have not yet performed a full transitive dependency license inventory for BusyIDE, BusyTeX, or TeXlyre.
- We have not contacted maintainers about commercial licensing options.
- Those are follow-up tasks, not blockers for the editor-foundation recommendation.

## Recommendation

Acceptable foundation licenses for Kuhn:

- MIT
- BSD-style licenses
- Apache-2.0

Conditionally acceptable:

- MPL-2.0, depending on file-level modification scope and distribution plan

Not acceptable as the main editor foundation without a deliberate business decision:

- AGPL-3.0
- GPL-3.0 for the core integrated webapp

Potentially acceptable with an explicit product strategy decision:

- AGPL-3.0 for the editor shell, if Kuhn adopts an open-core model and treats the public editor fork as a deliberate part of the business

## Sources

- [TeXlyre repository](https://github.com/TeXlyre/texlyre)
- [Overleaf Community Edition repository](https://github.com/overleaf/overleaf)
- [BusyIDE repository](https://github.com/busytex/busyide)
- [BusyTeX repository](https://github.com/busytex/busytex)
- [SwiftLaTeX organization](https://github.com/SwiftLaTeX)
