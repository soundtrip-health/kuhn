# Epic 007: Identity & User Memory

**Status:** ready
**Created:** 2026-07-12
**Updated:** 2026-07-12

## Goal

Make Kuhn know *who* it's working with and *what it has learned about them* —
so agents adapt to each user's working style, preferences, and habits across
sessions and projects. Two halves, deliberately in one epic because the second
is unbuildable without the first:

1. **Identity you can trust.** Today identity is a spoofable `x-kuhn-user`
   header falling back to a dev user (`session.js`), and no content row
   records who did anything — `conversations`, `jobs`, and `messages` have no
   `user_id`; two users on one project share a single conversation stream.
   This epic stamps attribution everywhere and swaps the dev stub for real
   (still minimal) authentication at the documented swap point. It also
   closes the long-flagged **Yjs room authorization** hole, which has no
   owning open story (violating epics rule #2).

2. **A user memory system.** A store of small, durable facts per user
   (preferences, style, recurring corrections), written by a cheap
   post-session distillation pass — not by agents burning turns on
   bookkeeping — injected into agent system prompts at run time, and fully
   visible and editable by the user. Silent profiling is both creepier and
   less accurate than a "What Kuhn knows about you" panel the user can fix.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Auth depth | **Minimal real auth: email magic-link + signed session cookie** | Resolves the architecture open question "auth provider choice" with the smallest trustworthy mechanism: no passwords to store, works for invited collaborators, and `session.js` remains the single swap point if SSO lands later. |
| Attribution first | **Stamp `user_id` before shipping auth** | Distillation needs attributable transcripts; stamping is cheap now and hardens automatically when the identity behind it becomes real. |
| Memory write path | **Post-job distillation (Haiku), not in-loop tools** | Zero latency/token cost during interactive use; the transcript is already persisted (`messages`). An explicit "remember this" user action is additive later. |
| Memory shape | **Small discrete facts with kind + scope** | `preference | style | domain | workflow` facts scoped user-global or user+org; top-N injected as a system-prompt footer via `buildSystemPrompt` (which today injects nothing user-specific — a clean seam). |
| Transparency | **User-visible, editable, deletable** | Trust requirement for a writing tool; also the correction loop that keeps memory accurate. |

## Scope

### Must Have

- [ ] `user_id` attribution on conversations, jobs, and messages
- [ ] Real login (magic link + session cookie); `x-kuhn-user` dev-only
- [ ] Yjs room authorization tied to project membership
- [ ] `user_memories` store + post-job distillation with dedup/decay
- [ ] Memory injection into `buildSystemPrompt`, bounded and relevant
- [ ] "What Kuhn knows about you" panel: view, edit, delete, pause

### Deferred

- SSO / external auth providers (swap point preserved)
- Org invites, role management UI, billing, quotas (next tenancy epic)
- Per-conversation-stream-per-user chat model (the story-013 known issue —
  revisit once attribution data shows real multi-user collision)
- Row-level security; extending membership guards to `files`/`render`/
  `agent`/`citations` routes (carried from Epic 004 story 005 — pull in here
  if auth work makes it cheap)
- In-loop `remember` agent tool and org-level "house style" memory

## Stories

| # | Story | Status | Size |
|---|-------|--------|------|
| 001 | [User attribution on content rows](stories/001-user-attribution.md) — `user_id` on conversations/jobs/messages, stamped from session | ready | S |
| 002 | [Minimal real auth](stories/002-minimal-real-auth.md) — magic-link login, signed session cookie, dev-mode fallback, logout | ready | L |
| 003 | [Yjs room authorization](stories/003-yjs-room-authorization.md) — membership-checked room join tokens | ready | M |
| 004 | [User memory store & distillation](stories/004-memory-store-distillation.md) — `user_memories` table, post-job Haiku distillation, dedup/decay | ready | L |
| 005 | [Memory injection at run time](stories/005-memory-injection.md) — bounded, relevance-ranked footer in `buildSystemPrompt` | ready | M |
| 006 | ["What Kuhn knows about you" panel](stories/006-memory-panel.md) — view/edit/delete/pause UI | ready | M |

## Sequencing

001 first (tiny, unblocks everything). Then two parallel tracks:
identity (002 → 003) and memory (004 → 005 → 006). Memory can be built and
evaluated on the dev-stub identity — it becomes trustworthy, not different,
when 002 lands. Ship the epic only with both tracks done.

## Risks

- **Memory quality** — a distiller that hoards trivia ("user asked about
  sample size once") poisons prompts. Story 004's distillation prompt and cap
  discipline are the real work; budget eval iterations.
- **Privacy expectations** — memory must never leak across users or orgs;
  scoping tests are mandatory, and the panel (006) is the escape valve.
  A user with memory paused must see zero behavioral difference from today.
- **Auth scope creep** — magic link only; the moment invites/roles/SSO pull
  in, stop and file the next tenancy epic.
- **Session/collab coupling** — cookie auth changes how the Yjs WS and SSE
  endpoints authenticate (003 depends on 002's session mechanism for the WS
  upgrade path).
