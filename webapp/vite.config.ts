import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

// Build-stamp the app so the running UI advertises exactly what code it is.
// The semver in package.json is bumped by hand (major/minor/fix as warranted);
// the short git rev + a `+` dirty flag change automatically with every commit
// or uncommitted edit, so the status-bar version is never ambiguous.
const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version as string;

function gitRev(): string {
  const run = (cmd: string) =>
    execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const sha = run('git rev-parse --short HEAD');
    const dirty = run('git status --porcelain').length > 0;
    return `${sha}${dirty ? '+' : ''}`;
  } catch {
    return 'nogit';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_REV__: JSON.stringify(gitRev()),
  },
  // Pinned so the backend CORS allowlist stays in sync (5173 is Vite's
  // default and often taken by other local apps; we claim 5174).
  server: {
    port: 5174,
    strictPort: true,
  },
});
