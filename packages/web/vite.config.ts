import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for the client.
 *
 * `publicDir` is disabled: the holding page lives in `holding/`, not `public/`,
 * precisely so Vite does not copy it into `dist/` and overwrite the built
 * `index.html`. The server chooses between the two surfaces at runtime via
 * `WEB_SURFACE` — see packages/server/src/app.ts.
 */
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // Readable stack traces matter more than the last few kilobytes, matching
    // the choice made for the server bundle.
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // So `pnpm dev` in the client talks to a locally running server rather
      // than needing CORS.
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
});
