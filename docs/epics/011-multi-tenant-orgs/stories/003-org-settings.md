# Story 011-003: Org settings surface

**Status:** ready
**Epic:** [011 — Multi-Tenant Orgs & Administration](../index.md)
**Estimate:** S

## Goal

One owner-only settings panel per org, so the knobs other stories introduce
have a home instead of each inventing its own. Today `organizations` holds
only name/slug and nothing is configurable post-creation.

## Sketch

- Schema: `organizations.settings TEXT NOT NULL DEFAULT '{}'` (JSON, same
  pattern as `projects.config`) — avoids a migration per knob.
- v1 knobs:
  - display name (rename; slug stays immutable — it's in storage paths)
  - default role for new members (invitation prefill + OIDC JIT default,
    010-004)
  - library seeding offer on/off (the 006-004 org-creation seed step)
  - promotion policy: `approval-required` / `direct` (consumed by 011-004;
    default approval-required once that ships)
- Spend ceilings (009-003) live in the same panel when that story lands —
  reserve the section, don't build it here.
- Routes: `GET/PATCH /api/orgs/:orgId/settings`, owner-only, validated
  against a known-keys schema (unknown keys rejected, not stored).
- UI: settings tab alongside the members panel (011-002) in the org admin
  surface.

## Acceptance Criteria

- [ ] Owners read/update settings; editors get 403 on the routes.
- [ ] Unknown or malformed keys are rejected with a field-level error.
- [ ] Default-role and promotion-policy settings are actually consumed by
      their features (or documented as pending those stories, with the key
      names fixed here).
- [ ] Rename propagates everywhere the org name renders; slug is immutable
      via API.

## Notes

- Settings are org-tenancy data — reads/writes go through the same
  membership-guard helpers as everything else; no separate settings service.
