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

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
