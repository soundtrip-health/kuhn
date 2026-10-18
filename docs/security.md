# Security

Kuhn's security documentation lives under [`docs/security/`](security/):

- **[Threat model & data classification](security/threat-model.md)** — trust boundaries,
  principals, data classes, egress policy, the threat inventory (T-xx) with current
  controls and owning issues, and the invariants reviews enforce.

Related:

- [ADR 002 — production deployment topology](adr/002-production-deployment-topology.md):
  the target topology (worker/sandbox split, proxy/TLS, backups) the threat model assumes.
- [deployment.md](deployment.md): how the current build is run, including
  [what is deployed today](deployment.md#as-deployed-today-2026-10) versus the target.
- [data-pipeline.md](data-pipeline.md): where data is stored and what leaves the machine.
- [architecture.md § Identity, Credentials and Secrets](architecture.md#identity-credentials-and-secrets):
  sessions, personal API tokens, the org secrets store.

Open hardening work (sandbox container isolation, removing the web process's Docker access,
boot-time config validation, backups) is tracked in the threat model's issue map and ADR 002;
it is not yet complete. Please report suspected vulnerabilities privately to the maintainers
rather than in public issues.
