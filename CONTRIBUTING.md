# Contributing to Kuhn

Thanks for your interest! Kuhn is early-stage and moving fast, so the process is
deliberately lightweight.

## Getting started

Follow the Quick start in [README.md](README.md) to get both apps running, and read
[CLAUDE.md](CLAUDE.md) for repository layout, where things live, and code conventions —
it is the contributor guide (for humans and AI assistants alike).

## Reporting bugs & proposing features

Open a [GitHub issue](https://github.com/soundtrip-health/kuhn/issues). For bugs, include
what you did, what you expected, and what happened; for features, a sentence or two on the
problem you're trying to solve is more useful than a detailed design.

## Pull requests

- Branch from `main`; keep PRs focused on one change.
- Match the surrounding code — plain ESM, small single-purpose modules, no frameworks in
  the webapp. See the Conventions section of [CLAUDE.md](CLAUDE.md).
- Run the tests: `npm test` inside `agent-backend/` and `webapp/`. The webapp build
  (`npm run build`) must pass — type errors fail it.
- New behavior should come with colocated vitest tests (`*.test.js`).

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every pull request and on pushes to
`main`. It is fully deterministic: no model credentials, no live-provider calls, and no model
quota is spent by ordinary CI.

**Required checks.** Repository owners should make both of the following status checks required
via branch protection on `main` — a PR cannot be merge-ready while either is failing:

- `backend` — `npm ci`, `npm test`, and `npm run test:runtime-contract` (the provider-neutral
  runtime contract suite, run against fake/scripted providers) in `agent-backend/`, with an
  isolated `KUHN_DATA_DIR`.
- `webapp` — `npm ci`, `npm test`, and `npm run build` in `webapp/` (type errors fail the build).

**What CI intentionally does not run.**

- The webapp check scripts (`npm run smoke`, `editor-check`, `parity-check`, `smoke:chat`,
  `write-check`, …) drive a running backend + webapp dev server through a Playwright browser and
  mutate the shared test project. Run them locally; see [TESTING.md](TESTING.md).
- Render/export shells out to the sandboxed Typst/Pandoc Docker images via `sandbox.js`;
  `render.test.js` covers the render routes with the sandbox mocked.
- Live provider runs (`npm run smoke` and `npm run smoke:pi-runtime` in `agent-backend/`) need
  `ANTHROPIC_API_KEY` and spend real quota. They belong in a separate protected/manual lane with
  scoped secrets and a spend cap — never on every PR.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
