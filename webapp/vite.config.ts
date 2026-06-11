import { defineConfig } from 'vite';

export default defineConfig({
  // Pinned so the backend CORS allowlist stays in sync (5173 is Vite's
  // default and often taken by other local apps; we claim 5174).
  server: {
    port: 5174,
    strictPort: true,
  },
});
