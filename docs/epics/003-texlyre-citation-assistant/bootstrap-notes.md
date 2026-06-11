# TeXlyre Bootstrap Notes

This note captures the current operational baseline for running the vendored `texlyre/` fork inside Kuhn.

## Current status

**Verified working** as of 2026-04-11 with Node v24.13.1 (npm 11.8.0) installed via nvm.

- `npm ci` installs 1127 packages cleanly (no `EBADENGINE`, no invalid/extraneous packages)
- `npm run dev` completes `predev` asset setup and starts Vite in ~200ms at `http://127.0.0.1:5173/texlyre/`
- `npm run build` completes in ~7s (produces `dist/`)
- 1 high-severity npm audit finding exists (non-blocking; run `npm audit` for details)

### Previous issues (resolved)

When using Node v24.2.0 (below the fork's `>=24.13.1` engine requirement):

1. `npm install` emitted `EBADENGINE` warnings
2. The resulting `node_modules/` tree was inconsistent
3. `node_modules/fs-extra/` was left empty
4. `npm run dev` failed during `predev` with `Cannot find module 'fs-extra'`

The fix was simply installing the correct Node version via nvm.

## Recommended clean bootstrap workflow

Verified working on macOS (Darwin 24.6.0, arm64):

```bash
cd texlyre
nvm use              # switches to 24.13.1 per .nvmrc
npm ci               # clean install — ~12s, 1127 packages
npm run dev -- --host 127.0.0.1   # Vite dev server on http://127.0.0.1:5173/texlyre/
```

If `nvm` is not installed, use any equivalent version manager and select `Node 24.13.1` or newer before installing dependencies.

## Expected dev entrypoint

The main local workflow is:

- `npm ci` for dependency installation
- `npm run dev` for the Vite development server

Relevant script chain:

- `predev` runs `node scripts/setup-assets.cjs`
- `dev` runs `node scripts/pm.cjs vite`

Because `predev` depends on `fs-extra`, a partially installed dependency tree fails before Vite starts.

## Fork-specific constraints

- The fork currently expects a much newer Node runtime than Kuhn's top-level docs advertise.
- Bootstrap is sensitive to install integrity; a partial install leaves the workspace in a misleading state where `node_modules/` exists but runtime dependencies are missing.
- `npm run build` begins plugin generation before asset setup, so successful startup should be validated with both `npm run dev` and `npm run build` once the correct Node version is available.

## Verified results

All three checks pass on Node 24.13.1:

- [x] `npm ci` completes without leaving invalid packages
- [x] `npm run dev` reaches a live local server (Vite on port 5173)
- [x] `npm run build` completes successfully (~7s, produces `dist/`)

`texlyre/` is now a validated editor baseline for Epic 003.
