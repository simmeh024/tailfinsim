import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env';

/**
 * Process entry point — the thing systemd runs.
 *
 * **Still a placeholder.** M0-08 replaces the routing here with the Fastify
 * app, Pino structured logging, request IDs and a `/healthz` that reports real
 * database connectivity. M0-09 replaces the holding page with the built client.
 *
 * What is deliberate and should survive both:
 *   - env is validated before the listener opens, so a misconfigured process
 *     dies immediately and visibly rather than serving errors
 *   - SIGTERM drains rather than dropping connections, because every deploy
 *     restarts this process
 *   - there is no general static file handler. Exactly one asset is served,
 *     read once at boot, so there is no path to traverse.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Resolves the same from `src` (dev) and `dist` (built), since both sit one
// level under packages/server.
const HOLDING_PAGE = resolve(here, '..', '..', 'web', 'public', 'index.html');

const env = loadEnv();
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

/**
 * Read the page once at startup. Failing here is correct: a deploy that cannot
 * find its own assets should not come up and pass a health check.
 */
let holdingPage: Buffer;
try {
  holdingPage = readFileSync(HOLDING_PAGE);
} catch (cause) {
  throw new Error(`Could not read the holding page at ${HOLDING_PAGE}`, { cause });
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        status: 'ok',
        // M0-08: replace with a real `select 1` against the pool.
        db: 'not-checked',
        uptime: Math.round(process.uptime()),
      }),
    );
    return;
  }

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Short, so the page can be changed without waiting out a cache.
      'cache-control': 'public, max-age=60',
      'content-length': holdingPage.byteLength,
      'x-content-type-options': 'nosniff',
    });
    // HEAD must not carry a body.
    res.end(req.method === 'HEAD' ? undefined : holdingPage);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => {
  console.warn(`tailfin-server listening on :${port} (${env.nodeEnv}, log=${env.logLevel})`);
});

/**
 * Graceful shutdown. `deploy.sh` restarts this process on every release, so
 * this path runs on each deploy, not just on outages.
 */
function shutdown(signal: string): void {
  console.warn(`${signal} received, draining`);
  server.close(() => {
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
