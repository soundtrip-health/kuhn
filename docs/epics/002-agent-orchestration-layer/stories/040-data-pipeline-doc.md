# Story 040: Data & file pipeline documentation

**Status:** done
**Epic:** [002 — Agent Orchestration Layer](../index.md)
**Estimate:** S

## Goal

An org evaluating Kuhn needs to understand **upfront** how and where its data
is processed and persisted — before uploading a protocol or draft. Write an
operator-facing document that lays out the full data/file pipeline: what is
stored where, what is processed how, what is ephemeral, and what leaves the
machine (LLM provider, PubMed/arXiv, SMTP).

## Acceptance Criteria

- [x] `docs/data-pipeline.md` covers: data-at-rest layout (`KUHN_DATA_DIR`,
      SQLite tables and the user content each holds), every ingress path
      (uploads, autosave, agent writes, org library), processing (org-library
      ingestion, render/export sandboxes and their isolation flags),
      ephemeral state (Yjs rooms, SSE), all network egress, auth/session
      data, retention/deletion semantics, and multi-tenancy boundaries.
- [x] Every claim grounded in the code (file references included), written
      against the tree at the time of this story.
- [x] A production checklist section flags the sharp edges: dev auth mode has
      no authentication, no built-in backups or retention policy, magic links
      log to console without SMTP, provider-side data handling is governed by
      the Anthropic account, not this repo.
- [x] Linked from `README.md` and `docs/architecture.md`.

## Notes

- The doc is a snapshot; it states its as-of date. Keeping it honest when the
  pipeline changes is part of the change that moves data (same spirit as the
  "publish sites" comment in `project-events.js`).
