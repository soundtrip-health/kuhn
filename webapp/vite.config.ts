import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const entry = (file: string): string => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_REV__: JSON.stringify(gitRev()),
  },
  // Multi-entry (epic 013 story 002): the member app plus the slim external-
  // reviewer surface. In production the backend serves review.html for
  // /review/* (agent-backend index.js static branch).
  build: {
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        review: entry('./review.html'),
      },
    },
  },
  plugins: [
    {
      // Dev-server equivalent of the backend's /review/* static branch, so
      // /review/<token> works under `npm run dev` too.
      name: 'kuhn-review-entry',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/review' || req.url?.startsWith('/review/')) req.url = '/review.html';
          next();
        });
      },
    },
  ],
  // Pinned so the backend CORS allowlist stays in sync (5173 is Vite's
  // default and often taken by other local apps; we claim 5174).
  server: {
    port: 5174,
    strictPort: true,
  },
});
