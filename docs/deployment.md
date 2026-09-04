# Deployment

The current Kuhn build runs as a single Node.js process. The agent backend serves the REST
API, the WebSocket endpoints (Yjs collaboration), and the built webapp on one
port (default **3002**), so a deployment needs exactly one service exposed to
the network — typically behind a TLS-terminating tunnel or reverse proxy such
as a Cloudflare Tunnel.

> **Current build, not yet the approved production baseline:** this page documents how
> to run the existing single-process implementation. It still has open fail-closed
> authentication, credential-URL, durability, and Docker-isolation work. For the
> *proposed* production topology for the first
> real-team pilot — the worker/sandbox split, database and file-storage
> decisions, backup/restore ownership, and the scale ceiling — see
> [ADR 002: production deployment topology](adr/002-production-deployment-topology.md).
> For the security model (trust boundaries, data classification, threats), see
> the [threat model](security/threat-model.md). Several hardening items called
> out below (fail-closed auth, backups, sandbox isolation) are tracked work, not
> yet implemented on `main`.

## Requirements

- **Node.js LTS** (e.g. 24). Node 26 currently fails to build the native
  `better-sqlite3` dependency.
- **Docker**, with the sandbox images pulled (rendering, export, slide decks,
  and PDF ingestion run in network-isolated containers):

  ```bash
  docker pull ghcr.io/typst/typst:latest pandoc/core:latest minidocks/poppler:latest
  docker build -t kuhn/marp:latest docker/marp                # marp + LibreOffice (editable pptx, STH-61)
  docker build -t kuhn/r-analysis:latest docker/r-analysis   # analyst R runtime (issue #68b) — built, not pulled
  ```

  The R image is Kuhn-built because the sandbox runs with `--network none`:
  every package the analyst can use is baked into `docker/r-analysis/Dockerfile`
  (rocker/r-ver + mgcv/lme4/tidyverse/etc., ~2 GB). Adding a package = editing
  that Dockerfile and rebuilding; there are no runtime installs.

- An **`ANTHROPIC_API_KEY`** with sufficient quota for agent runs.
- A public hostname with TLS. The examples below use a Cloudflare Tunnel. The current
  build also trusts request Host/forwarding metadata too broadly; do not treat proxying
  alone as the completed production fix described in ADR 002/STH-17.

## Build and run

From a clone of the repository:

```bash
npm install        # installs both packages
npm run build      # builds the webapp (webapp/dist)
npm start          # starts the backend on :3002
```

Production webapp builds call the API on the **same origin** they are served
from, and the backend serves `webapp/dist` automatically whenever it exists.
No build-time URL configuration is required for a single-port deployment.

On startup the backend creates the SQLite database, applies the schema, and
seeds the agents and tools; there is no separate database service. The log
confirms what is being served:

```
[kuhn] Agent backend listening on http://localhost:3002
[kuhn] Serving webapp: /srv/kuhn/webapp/dist
```

## Configuration

All configuration lives in `agent-backend/.env` (see `.env.example` for the
full list). A production instance needs:

```bash
ANTHROPIC_API_KEY=sk-ant-...

# Require login. Dev mode (the default) has no authentication at all and must
# never be exposed to a network.
KUHN_AUTH_MODE=magic-link
KUHN_SESSION_SECRET=<output of: openssl rand -hex 32>

# Public origin of the deployment — post-login redirect target; also marks the
# session cookie Secure.
KUHN_APP_URL=https://kuhn.example.com

# Platform operators (comma-separated). Super-admins create, rename, and
# suspend organizations via the admin console; the flag is synced into the
# database at every boot (listed emails gain it, unlisted lose it). It grants
# NO access to any org's content — operators see content only in orgs they
# are members of. In dev mode this defaults to the dev user; in production
# there is no default, so without it nobody can create organizations.
KUHN_SUPERADMIN_EMAILS=you@example.com

# Optional: how long org-invitation links stay valid (default 7 days).
# KUHN_INVITE_TTL_MS=604800000

# Optional: sign-in form rate limits (see "Rate limits on the sign-in form").
# Defaults are 3 attempts per address per 15 min, 20 per client IP per hour.
# KUHN_LOGIN_MAX_PER_EMAIL=3
# KUHN_LOGIN_EMAIL_WINDOW_MS=900000
# KUHN_LOGIN_MAX_PER_IP=20
# KUHN_LOGIN_IP_WINDOW_MS=3600000

# Email delivery for sign-in links. If unset, links are printed to the server
# console instead (see "Inviting users" below).
# KUHN_SMTP_URL=smtps://user:pass@host:465

# Data root: SQLite DB and uploaded project files. Defaults to ./data in the
# repo. Point it at backed-up, access-controlled storage in production.
# KUHN_DATA_DIR=/srv/kuhn/data

# Org secrets store (encrypted credentials agents use server-side — DB DSNs,
# API keys). Set a dedicated key and keep it OUT of database backups
# (ciphertext and key in different domains). Falls back to a key derived from
# KUHN_SESSION_SECRET when unset.
KUHN_SECRETS_KEY=<output of: openssl rand -hex 32>

# Secrets-enabled analyst script runs join this docker network to reach org
# data services (instead of --network none). Create it INTERNAL so sandboxes
# still cannot reach the internet:
#   docker network create --internal kuhn-data
# SANDBOX_SECRETS_NETWORK=kuhn-data
```

For a worked, end-to-end example of wiring an instance to a data warehouse —
least-privilege DB role (read-only data schema + writable scratch schema),
internal network, secret creation, per-project data brief — see
[`test-projects/02-nsduh-psychedelics/`](../test-projects/02-nsduh-psychedelics/README.md),
which doubles as the admin's guide for real private databases.

Notes:

- `CORS_ORIGIN` is **not** needed for a single-port deployment — the webapp
  and API share an origin, so no cross-origin requests occur.
- `KUHN_WEBAPP_DIST` overrides the directory served at `/` (default:
  `webapp/dist` in the repository). Set it to an empty string to disable
  static serving entirely.
- There is no built-in backup, retention, or at-rest encryption for
  `KUHN_DATA_DIR`; the host environment provides them. See
  [data-pipeline.md](data-pipeline.md) for the full data inventory and
  production checklist.

## Cloudflare Tunnel

With everything on one port, the tunnel configuration is a single ingress
rule:

```yaml
# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /path/to/<tunnel-id>.json

ingress:
  - hostname: kuhn.example.com
    service: http://localhost:3002
  - service: http_status:404
```

- WebSockets (Yjs collaboration) are proxied by cloudflared without extra
  configuration; the webapp derives `wss://` URLs from its own origin.
- **Current security gap:** the backend trusts all proxy hops and currently builds
  login, invitation, and review URLs from request protocol/Host. A trusted tunnel often
  makes the URL look correct, but Host remains attacker-influenced if the origin is
  reachable or forwarding headers are passed through. STH-17 must mint every
  credential-bearing URL from validated `KUHN_APP_URL`, bound proxy trust to known
  hops/subnets, strip client forwarding headers, and block direct origin reachability.

## Authentication and inviting users

`KUHN_AUTH_MODE=magic-link` enables passwordless email login. The install is
**invite-only** (STH-35): there is no self-registration, because agent runs
and sandboxed execution cost real money and anyone who can reach the login
box would otherwise be able to spend it.

One form handles everyone. A visitor enters their email address on the
sign-in screen and always sees the same confirmation — the response never
reveals whether that address has an account — but three different things can
land in the mailbox:

| The address | What is sent |
| --- | --- |
| Belongs to an organization (or is a super-admin) | A single-use sign-in link, 15-minute expiry |
| Has a pending, unredeemed invitation | That invitation, re-issued (the older link is revoked) |
| Anything else | "Your access request is queued" — no link, and **no account is created** |

Queued requests appear in the **platform console** (breadcrumb org menu,
super-admins only). Approving one asks for an organization and a role and
sends an ordinary invitation; denying one settles it silently — the requester
is not notified, so the login box cannot be used to probe which addresses an
administrator recognizes. An owner who invites the address directly settles
its queued request too.

Eligibility is re-checked when the link is clicked, not just when it is
mailed: if the last membership behind an account is removed while a link is
in flight, the link is dead on arrival (`?login=no-access`).

### Rate limits on the sign-in form

`POST /api/auth/request-link` is the only unauthenticated endpoint that sends
mail and writes rows, so it carries a budget. Over-budget attempts get
`429` with a `Retry-After` header — keyed on request volume, never on whether
the address exists, so the refusal discloses no more than the uniform `200`
it replaces.

| Env var | Default | Limits |
| --- | --- | --- |
| `KUHN_LOGIN_MAX_PER_EMAIL` | `3` | Attempts naming one address |
| `KUHN_LOGIN_EMAIL_WINDOW_MS` | `900000` (15 min) | …per this window |
| `KUHN_LOGIN_MAX_PER_IP` | `20` | Attempts from one client, any address |
| `KUHN_LOGIN_IP_WINDOW_MS` | `3600000` (60 min) | …per this window |

The two do different jobs, and it is worth knowing which one you are relying
on:

- **Per-email is the load-bearing limit.** It is keyed on the address being
  mailed, so nothing the sender controls can sidestep it. This is what stops
  the form being used to flood someone's inbox.
- **Per-IP is best-effort.** `req.ip` is derived from `X-Forwarded-For`
  because the backend runs with Express `trust proxy` enabled (it has to, to
  mint links on the public hostname). Proxies generally *append* to that
  header rather than replace it, so a client that sends its own
  `X-Forwarded-For` can rotate the key and get a fresh budget. Treat the
  per-IP cap as a guard against noise and accidents, not against a determined
  attacker, and size it generously — an entire institution can share one NAT
  address.

Malformed submissions count against the per-IP budget too, so the `400` path
is not a free channel. Limits are held in memory, per process: they reset on
restart, and an install running more than one backend process would give each
its own budget.

The first refusal in each window is recorded as an `access.throttled` row in
`auth_events`; the rest of that window is not, so a sustained flood leaves one
audit row per offender per window rather than one per attempt.

Membership itself is invitation-only (epic 011):

- A **super-admin** (`KUHN_SUPERADMIN_EMAILS`) creates organizations from the
  admin console, naming a first admin by email — an existing user becomes
  owner directly; anyone else receives an owner-role invitation link.
- An **org owner** invites members (and further owners) from the org-admin
  panel; each invitation emails a single-use link that signs the invitee in
  and adds them with the chosen role (`owner`, `editor`, or `viewer`).

With no `KUHN_SMTP_URL` configured, sign-in and invitation links are printed to the
backend log instead of emailed:

```
[auth] Magic link for alice@example.com: https://kuhn.example.com/api/auth/verify?token=...
[auth] Invitation to Example Lab for alice@example.com: https://kuhn.example.com/api/auth/verify?invite=...
[auth] Access request queued for stranger@example.com (no link sent — invite-only)
```

This fallback is for local development only. It exposes live authentication secrets to
anyone or any system that can read collected logs. A shared/production magic-link
deployment requires SMTP, and the target production profile in STH-17 must refuse to
start without it.

## Running as a service

Any process supervisor works; the backend is a single foreground Node
process. Example systemd unit:

```ini
# /etc/systemd/system/kuhn.service
[Unit]
Description=Kuhn agent backend
After=network.target docker.service

[Service]
User=kuhn
WorkingDirectory=/srv/kuhn/agent-backend
ExecStart=/usr/bin/npm run start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Split-origin deployments

The current build can serve the webapp from a different origin than the API (for example
`app.example.com` + `api.example.com`) with additional configuration, but this layout is
**outside ADR 002's proposed production baseline**. The current Host-derived
credential-URL behavior and shared-domain cookie assumptions need a separate validated
public API origin and end-to-end security tests before this is a supported production
topology.

For development/evaluation only:

- Build the webapp with the API origin baked in:
  `VITE_BACKEND_URL=https://api.example.com npm run build`, and serve
  `webapp/dist` from any static host.
- Set `CORS_ORIGIN` on the backend to the webapp origin.
- Both hostnames must share a registrable domain so the session cookie is
  sent cross-origin; set `KUHN_APP_URL` to the webapp origin.

Prefer the single-port layout unless you have a reason not to — it eliminates
CORS and cookie-scope configuration entirely.

## Upgrading

```bash
git pull
npm install        # picks up dependency changes in both packages
npm run build      # rebuild the webapp
# restart the backend (e.g. systemctl restart kuhn)
```

Schema changes and seed-data updates (agent prompts, tools) are applied
automatically at startup.

### Upgrading an install that predates roles (epic 011)

The multi-tenancy release migrates memberships automatically, but the role
assignment is deliberately conservative and needs one operator step:

- Existing magic-link users who had auto-joined the default organization
  become **editors**. The only owner after migration is the seeded dev user
  (`dev@kuhn.local`), so out of the box nobody real can administer the org.
- Set `KUHN_SUPERADMIN_EMAILS` to your operator address and restart, then
  promote yourself to owner of the default organization — either invite
  yourself with the owner role from the admin console, or run the one-time
  SQL against the database file:

  ```sql
  UPDATE memberships SET role = 'owner'
  WHERE user_id = (SELECT id FROM users WHERE email = 'you@example.com');
  ```

- New sign-ins no longer join any organization automatically; from here on,
  invitations are the only door in (see "Authentication and inviting users").
- New optional env vars: `KUHN_SUPERADMIN_EMAILS` (no production default) and
  `KUHN_INVITE_TTL_MS` (invitation link lifetime, default 7 days).

### Upgrading an install that predates invite-only sign-in (STH-35)

Removing self-registration is a **breaking change for accounts that never
joined an org** — the ones that used to sign in and land on an empty
workspace. They now get an access request instead of a link. Nothing is
deleted; they simply cannot sign in until someone invites them.

No migration runs, so check before you upgrade:

```sql
SELECT u.email FROM users u
WHERE u.is_superadmin = 0
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
```

Anyone listed who should keep access needs an invitation (from an org owner,
or by approving their request in the platform console once they ask again).
Confirm `KUHN_SUPERADMIN_EMAILS` is set to a real operator address first:
super-admins are exempt from the membership requirement precisely so that
tightening this rule cannot lock you out of your own install.

The sign-in form is also rate limited from this release on. The defaults suit
a lab-sized install; raise `KUHN_LOGIN_MAX_PER_IP` if your users share one
outbound address and report being refused.

## Model providers beyond the deployment key

Org owners can add provider/model profiles (OpenAI, OpenRouter, any OpenAI-compatible server,
or an org-owned Anthropic key) under **Settings → Models** and route each agent to a ranked
list of them by task difficulty; credentials are org secrets and never leave the server
(`docs/specs/107-model-profiles-and-routing.md`). Two operator knobs:

| Variable | Default | Meaning |
|---|---|---|
| `KUHN_ALLOW_PRIVATE_MODEL_ENDPOINTS` | `true` in dev auth mode, else `false` | Let an org profile point at a loopback / private-network base URL (a local vLLM or Ollama). Plain `http:` is only ever accepted for such hosts. |
| `KUHN_MODEL_TEST_TIMEOUT_MS` | `30000` | Time limit on the synthetic "Test connection" turn (no project content is sent). |

To prove a provider path against a real endpoint before routing agents to it, run
`npm run smoke:provider-matrix` in `agent-backend/` with the relevant credentials in the
environment; the token-free wire-level proof runs with `npm test`.
