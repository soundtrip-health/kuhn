# Knowledge-package source catalogs

Per-domain lists of authoritative, freely accessible documents (canonical URL,
publisher, format, access/license notes, short description) — one file per
planned knowledge package for issue #65. See
[`docs/specs/065-general-knowledge-library.md`](../../docs/specs/065-general-knowledge-library.md)
for the package model these feed.

These are **curation inputs, not app-consumed content**. The app will consume
`guidance-docs/catalog.json` (the package manifest, Phase 1 of the spec);
items graduate from these lists into the manifest as either:

- a **vendored document** — only when redistribution is clearly permitted
  (US-government public domain, CC-licensed, or Kuhn-authored), or
- a **knowledge card** — a Kuhn-authored markdown summary with the canonical
  link, for everything we may not redistribute.

**Caveat:** these lists were compiled by assisted web research (2026-08-11).
Most URLs were spot-verified at compile time, but every URL, license claim,
and edition/version must be re-verified by a curator before an item enters
`catalog.json` — and especially before any file is vendored into this repo.

| Package | File |
|---|---|
| General scientific writing | [general-scientific-writing.md](general-scientific-writing.md) |
| Biosciences (core) | [biosciences.md](biosciences.md) |
| Biosciences → regulatory | [biosciences-regulatory.md](biosciences-regulatory.md) |
| Biosciences → clinical trials | [biosciences-clinical-trials.md](biosciences-clinical-trials.md) |
| Biosciences → drug development | [biosciences-drug-development.md](biosciences-drug-development.md) |
| Machine learning | [machine-learning.md](machine-learning.md) |
| Robotics | [robotics.md](robotics.md) |
| Chemistry | [chemistry.md](chemistry.md) |
| Physics | [physics.md](physics.md) |
| General social sciences | [social-sciences.md](social-sciences.md) |
| Statistics & reproducible methods | [statistics-reproducible-methods.md](statistics-reproducible-methods.md) |
| Environmental & earth sciences | [environmental-earth-sciences.md](environmental-earth-sciences.md) |
