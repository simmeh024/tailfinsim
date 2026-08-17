import { createServer } from 'node:http';

import { loadEnv } from './env';

/**
 * Process entry point — the thing the container runs.
 *
 * **This is a placeholder.** M0-08 replaces the body of this file with the
 * Fastify app, Pino structured logging, request IDs and a `/healthz` that
 * reports real database connectivity. It exists now so the deployment pipeline
 * has something genuine to build, ship and run end to end rather than being
 * wired against a hypothetical.
 *
 * What is *not* placeholder and should survive M0-08:
 *   - env is validated before the listener opens, so a misconfigured process
 *     dies immediately and visibly rather than serving errors
 *   - SIGTERM drains rather than dropping connections, because the deploy
 *     path restarts this container on every release
 */

const env = loadEnv();
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
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

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, () => {
  console.warn(`tailfin-server listening on :${port} (${env.nodeEnv}, log=${env.logLevel})`);
});

/**
 * Graceful shutdown. The deploy timer stops and recreates this container on
 * every promotion, so this path runs on each release, not just on outages.
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
