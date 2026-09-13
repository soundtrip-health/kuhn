---
title: Accounts and organizations
area: accounts
keywords: sign in, magic link, login, session, sign out, organization, membership, role, viewer, editor, owner, invitation, access request, super-admin, platform console, API token, dev mode
---

# Accounts and organizations

Kuhn has no passwords. In production you sign in with a single-use emailed link, and the install is invite-only: an address gets a link only if it already belongs to an organization. What you can do is decided by your role in the organization you are working in.

## Signing in with a magic link

**What it does.** The "Sign in" screen takes an email address and always answers "Check your email". A member receives "Sign in to Kuhn" with a link that "is valid for 15 minutes and can be used once"; an address with an unredeemed invitation gets it re-sent; anyone else receives "Your Kuhn access request", saying the request is queued for an administrator — no account is created and no link is sent.

**How to use it.** Enter your address in "Email" and click "Continue" (the hint reads "Kuhn is invite-only. Members get a sign-in link; everyone else is queued for review."). If you are requesting access, the optional "Requesting access? Tell us who you are" box is kept with the request. Open the emailed link; it signs you in and returns you to the app.

**Prerequisites.** `KUHN_AUTH_MODE=magic-link` on the server (requires `KUHN_SESSION_SECRET`). Without `KUHN_SMTP_URL` nothing is emailed — the link is printed to the backend console as `[auth] Magic link for …`.

**Gotchas.** The screen never reveals whether an address has an account. Link lifetime is `KUHN_AUTH_TOKEN_TTL_MS` (default 15 minutes); a used or expired link returns you to sign-in with "That sign-in link has expired or was already used. Request a fresh one." Eligibility is re-checked when the link is opened, so a link issued just before your last membership was removed fails. Requests are rate-limited — three per address per 15 minutes, 20 per client per hour (`KUHN_LOGIN_MAX_PER_EMAIL`, `KUHN_LOGIN_MAX_PER_IP`) — with "Too many sign-in attempts. Try again in N minutes."

## Dev mode

**What it does.** With `KUHN_AUTH_MODE=dev` (the default) there is no sign-in screen. Every request resolves to the seeded dev user (`DEV_USER_EMAIL`, default `dev@kuhn.local`) or to the email in the `x-kuhn-user` request header; a user with no organization is attached to the seeded default organization, and the dev user is a super-admin.

**How to use it.** Start the backend without setting `KUHN_AUTH_MODE`. The account popover says "Dev mode — identity comes from the x-kuhn-user header; there is no session to sign out of."

**Prerequisites.** None.

**Gotchas.** For local development and the token-free check scripts only; the invite-only rules do not apply.

## Sessions and signing out

**What it does.** Opening a magic link creates a session held in a signed, HTTP-only cookie that lasts `KUHN_SESSION_TTL_MS` (default 30 days) from sign-in and is not extended by use. When it expires mid-use the sign-in screen reappears.

**How to use it.** Click the avatar (your initials) at the right of the top bar. The popover shows your name and email, "Platform super-admin" if applicable, your role in the active organization ("Owner of …", "Editor of …", "Viewer of …") and "Member of N organizations — switch in the breadcrumb." when you belong to several. "Sign out" revokes the session and reloads into the sign-in screen.

**Prerequisites.** Magic-link mode.

**Gotchas.** Signing out ends only this device's session and leaves personal API tokens working.

## Organizations and membership

**What it does.** An organization is the tenant: projects, the knowledge library, shared scripts, model routes and budgets belong to one. You reach a project only through a membership, and the server answers "not found" for any organization you do not belong to.

**How to use it.** Membership comes from an invitation (or the automatic default-organization join in dev mode). Owners manage members under "Org admin…" → "Members" (see `org-admin.md`).

**Prerequisites.** Organizations are provisioned by a super-admin; members cannot create them.

**Gotchas.** With no membership you see "No organizations yet — organizations are invitation-only." in the breadcrumb menu. A suspended organization shows "This organization is suspended. Its projects and library are unavailable until a platform administrator reactivates it." and refuses every request until a super-admin reactivates it.

## Roles: viewer, editor, owner

**What it does.** Each membership has one role, ranked viewer < editor < owner, and every route checks it. Viewer: read-only — browse projects, files, previews, comments and chat history; the chat composer and file actions are disabled and live-collaboration sockets are read-only. Editor: also create and rename projects, run the wizard and seeding, upload, create, move, rename and delete files, edit documents, direct agents, and add files to the library. Owner: also members and roles, invitations, settings, knowledge, scripts, secrets, budgets, models, slide themes, page-layout templates and promotion approvals.

**How to use it.** The account popover states your role with "Read-only access to this organization.", "Edit projects and documents in this organization." or "Manage members, settings and knowledge for this organization." Owners change roles in "Org admin…" → "Members".

**Prerequisites.** None.

**Gotchas.** An organization must keep at least one owner — demoting or removing the last is refused. A role change applies on the next request; when one is refused with `requires editor role` the app re-reads your organizations and re-renders. Live-collaboration sessions are re-checked every 60 seconds and closed on removal, demotion or suspension.

## Switching organizations

**What it does.** The first breadcrumb segment names the active organization; clicking it lists every organization you belong to, with a check mark on the active one.

**How to use it.** Choose one; its projects load and the first opens. The menu also holds "Org library…", "Org admin…" (owners) or "Org knowledge…" (other members), and for super-admins "New organization…" and "Platform console…". Arrow keys move through it; Escape closes it.

**Prerequisites.** More than one membership.

**Gotchas.** The last organization and project are remembered in this browser and restored on reload.

## Invitations and access requests

**What it does.** An invitation is the only way into an organization. Owners send one from "Org admin…" → "Members" ("Email to invite", a role, "Send invitation"); the invitee receives "You're invited to <org> on Kuhn" with a link that "is valid for 7 day(s) and can be used once". Opening it creates the account if needed, grants the membership at the invited role and signs the person in. A stranger who signs in on the login screen becomes an access request that super-admins "Approve & invite" (choosing an organization and role) or "Deny" (the requester is not notified) in the platform console.

**How to use it.** Owners: "Send invitation" and "Revoke" in the Members tab, which lists each invitation's role, state (pending, accepted, revoked, expired) and expiry. Invitees: open the link. A lost invitation is re-issued by entering the address on the sign-in screen.

**Prerequisites.** Owner role to invite; super-admin to decide access requests. Lifetime is `KUHN_INVITE_TTL_MS` (default 7 days).

**Gotchas.** Inviting an existing member is refused with "already a member of this organization" — change the role instead. A new invitation revokes the earlier pending one for the same address. A dead link explains itself on the sign-in screen (expired, revoked, already used, not valid, already a member); for a suspended organization "The link stays valid — try again once the organization is reactivated."

## Super-admin and the platform console

**What it does.** Super-admin is a platform flag, not a role: the comma-separated emails in `KUHN_SUPERADMIN_EMAILS` are synced to it at every backend start, both ways. Super-admins provision organizations and manage the install, but the flag grants no access to any organization's content.

**How to use it.** In the breadcrumb menu, "New organization…" creates an organization and "Platform console…" opens the console: every organization with status, member count and created date, per-row "Open", "Rename" and "Suspend" / "Reactivate"; the "Access requests" queue; and "Create an organization" (a name and a first-admin email, defaulting to you). "Open" joins you as an owner if you are not a member yet — an ordinary, audited membership other members can see and remove — then switches the workspace into it.

**Prerequisites.** Your email in `KUHN_SUPERADMIN_EMAILS`, then a backend restart. Outside dev mode nobody is a super-admin unless listed.

**Gotchas.** Creating an organization for someone else's email hands it over — that address gets an owner invitation (or a direct owner membership if the account exists) and you get no access. "Suspend" asks for confirmation and locks every member out until "Reactivate". A super-admin can always sign in, even with no memberships.

## Personal API tokens

**What it does.** A bearer token that lets scripts and external tools act as you — same organizations, roles and attribution — sent as an `Authorization: Bearer` header. Tokens power the interchange with other writing tools; see `interchange.md`.

**How to use it.** Account popover → "API tokens". Give it a "Name", pick "Expires in" (30 days, 90 days or 1 year), click "Create token" and copy the value: "This token is shown once — copy it now. Kuhn keeps only a hash of it." "Your tokens" lists creation, expiry and last use; "Revoke" stops a token immediately, "Remove" clears an expired one.

**Prerequisites.** A signed-in session (dev mode included). A request authenticated with a token cannot list, create or revoke tokens.

**Gotchas.** Revoking a token signs out anything using it at once; sessions are unaffected.
