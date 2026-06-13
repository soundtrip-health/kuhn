# Epic 004: Editor Upgrade (Crepe) + Project Management

**Status:** done
**Created:** 2026-06-13
**Updated:** 2026-06-13

## Goal

Turn the Epic 002 prototype into a usable product by closing its two biggest
gaps:

1. **A real editor.** Replace the hand-rolled Milkdown build with **Milkdown
   Crepe** — a feature-complete, Notion-style distribution (toolbar, block-edit
   slash menu, block handle, image block, table, CodeMirror code blocks, link
   tooltip, list items, placeholder, LaTeX) — while preserving Kuhn's
   collaboration path and agent surface (citation chips, `/cite`, `/write`).

2. **Real project management.** Introduce a full org → project → document
   hierarchy: an `organizations` data model with org-scoped projects, a
   project/document browser, and a top-left breadcrumb wired to the actual
   organization, project, and open document instead of hardcoded text.

A test user can sign in, browse their organization's projects, open a document
in a polished editor, draft with `/cite` and `/write`, and see the breadcrumb
reflect exactly where they are.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Editor | **Adopt Milkdown Crepe** (on `CrepeBuilder`) | Crepe ships the toolbar/blocks/slash UX we'd otherwise hand-build; the current editor is sparse and the bespoke `slash.ts` caret tracking is the main glitch source. Notion-like patterns are acceptable. |
| Collaboration | **Keep Yjs; port onto Crepe** | Crepe doesn't bundle collab. We re-attach `@milkdown/plugin-collab` to Crepe's underlying editor rather than drop the multi-user path. |
| In-editor AI | **Keep custom surface** | Re-attach citation chips, `/cite` picker, and `/write` streamed suggestion as custom plugins; keep agent-routed slash commands. We do **not** adopt Crepe's built-in AI feature — it would bypass the agent-task boundary (Epic 002). |
| Tenancy | **Full org/tenant model now** | Pull forward `organizations` + org-scoped projects + browsing. A minimal identity/session makes scoping real; full SSO stays out of scope. Honors the architecture's three tenancy invariants. |

See [docs/architecture.md](../../architecture.md) §Multi-Tenancy Invariants —
Story 005 must honor project-scoped rows, the single project-root-enforced
storage API, and sandboxed execution.

## Scope

### Must Have

- [x] Crepe editor shell replacing `editor.ts` internals, themed to "Column"
- [x] Collaboration (Yjs) working on Crepe, including the story-024 reload fix
- [x] Custom surface re-mounted on Crepe: citation chips, `/cite`, `/write`,
      agent-routed slash commands in one menu
- [x] `organizations` / `users` / `memberships` data model; org-scoped projects
- [x] Org → project → document browser with new-project flow
- [x] Breadcrumb wired to live org / project / document; segments navigable

### Deferred

- Full auth provider / SSO (minimal identity only; see architecture open
  question "Auth provider choice")
- Crepe's built-in AI feature (diff-review)
- Per-tenant KB and shared guidance corpus browsing (future epic)
- Org admin (invites, roles, billing, quotas)
- Yjs room authorization (carries over from Epic 002 deferred list)

## Stories

### Phase 1: Crepe editor migration

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [Crepe editor shell](stories/001-crepe-editor-shell.md) — swap `Editor.make()` for `CrepeBuilder`, theme to Column, preserve save/word-count/hero | done | L |
| 002 | [Collaboration on Crepe](stories/002-collab-on-crepe.md) — port `@milkdown/plugin-collab` onto `crepe.editor`; carry the 024 reload fix | done | M |
| 003 | [Custom plugins on Crepe](stories/003-custom-plugins-on-crepe.md) — citation chips, `/cite`, `/write`, unified slash menu; retire `slash.ts` | done | L |
| 004 | [Editor parity & glitch sweep](stories/004-editor-parity-glitch-sweep.md) — QA against the sparse/glitchy baseline; file follow-ups | done | S |

### Phase 2: Org & project management

| # | Story | Status | Size |
|---|-------|--------|------|
| 005 | [Org/tenant data model & API](stories/005-org-tenant-model.md) — `organizations`/`users`/`memberships`, `projects.org_id`, scoped queries, minimal session | done | L |
| 006 | [Project & document browser](stories/006-project-document-browser.md) — org/project switcher, projects dashboard, new-project flow, active-document persistence | done | L |
| 007 | [Breadcrumb wired to the file system](stories/007-breadcrumb-wired-to-filesystem.md) — live org/project/document segments, navigable; drop hardcoded text | done | M |

## Sequencing

Phase 1 (001 → 002 → 003 → 004) and Phase 2 (005 → 006 → 007) are largely
independent and can proceed in parallel. Within each phase the order is
sequential: 001 establishes the Crepe shell the others build on; 005 establishes
the org model the browser and breadcrumb consume. Story 007 depends on 006's
navigation state.

## Risks

- **Crepe + collab compatibility** (002) is the top technical risk — spike
  early. Fallback: keep collab on a thin custom layer over `crepe.editor`.
- **Crepe theme vs. Column tokens** (001) — Crepe ships its own CSS; reconciling
  with `kuhn-tokens.css` may need overrides rather than a clean swap.
- **Identity depth** (005) — kept deliberately minimal to avoid pulling a full
  auth epic into scope.
