# Deployment

Kuhn deploys as a single Node.js process. The agent backend serves the REST
API, the WebSocket endpoints (Yjs collaboration), and the built webapp on one
port (default **3002**), so a deployment needs exactly one service exposed to
the network — typically behind a TLS-terminating tunnel or reverse proxy such
as a Cloudflare Tunnel.

## Requirements

- **Node.js LTS** (e.g. 24). Node 26 currently fails to build the native
  `better-sqlite3` dependency.
- **Docker**, with the sandbox images pulled (rendering, export, and PDF
  ingestion run in network-isolated containers):

  ```bash
  docker pull ghcr.io/typst/typst:latest pandoc/core:latest minidocks/poppler:latest
  ```

- An **`ANTHROPIC_API_KEY`** with sufficient quota for agent runs.
- A public hostname with TLS. The examples below use a Cloudflare Tunnel, but
  any reverse proxy that forwards WebSockets and sets `X-Forwarded-Proto`
  works the same way.

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

# Email delivery for sign-in links. If unset, links are printed to the server
# console instead (see "Inviting users" below).
# KUHN_SMTP_URL=smtps://user:pass@host:465

# Data root: SQLite DB and uploaded project files. Defaults to ./data in the
# repo. Point it at backed-up, access-controlled storage in production.
# KUHN_DATA_DIR=/srv/kuhn/data
```

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
- The backend trusts `X-Forwarded-Proto`/`Host` (Express `trust proxy`), so
  magic links are minted as `https://kuhn.example.com/...` behind the tunnel.

## Authentication and inviting users

`KUHN_AUTH_MODE=magic-link` enables passwordless email login. A visitor
enters their email address on the sign-in screen and receives a single-use
link (15-minute expiry). Signing in creates the user but grants **no
organization membership** — an uninvited user lands on an empty workspace
that tells them to ask their admin for an invitation.

Membership is invitation-only (epic 011):

- A **super-admin** (`KUHN_SUPERADMIN_EMAILS`) creates organizations from the
  admin console, naming a first admin by email — an existing user becomes
  owner directly; anyone else receives an owner-role invitation link.
- An **org owner** invites members (and further owners) from the org-admin
  panel; each invitation emails a single-use link that signs the invitee in
  and adds them with the chosen role (`owner`, `editor`, or `viewer`).

With no `KUHN_SMTP_URL` configured, sign-in and invitation links are printed
to the backend log instead of emailed:

```
[auth] Magic link for alice@example.com: https://kuhn.example.com/api/auth/verify?token=...
[auth] Invitation to Example Lab for alice@example.com: https://kuhn.example.com/api/auth/verify?invite=...
```

For a small test deployment this is a workable manual flow — the operator
copies the link from the log and sends it to the invitee. Configure
`KUHN_SMTP_URL` for self-service delivery.

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

Serving the webapp from a different origin than the API (e.g. `app.example.com`
+ `api.example.com`) is supported but requires additional configuration:

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
