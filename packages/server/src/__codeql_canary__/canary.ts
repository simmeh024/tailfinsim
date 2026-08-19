/**
 * CANARY — DELETE. Not for merge.
 *
 * Three deliberate vulnerabilities, to work out what the analyser can actually
 * see. The first two go through Fastify; the third uses Node's own `http`,
 * which CodeQL models natively and which therefore isolates "is taint analysis
 * working at all" from "is Fastify being modelled".
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

export function registerCanary(app: FastifyInstance): void {
  app.get<{ Querystring: { expr?: string; file?: string } }>('/__canary', async (request) => {
    // js/code-injection, via a Fastify request
    const evaluated: unknown = eval(String(request.query.expr));
    // js/path-injection, via a Fastify request
    const contents = readFileSync(String(request.query.file), 'utf8');
    return { evaluated, contents };
  });
}

/** Same sink, but from a source CodeQL models without any dependency present. */
export const canaryServer = createServer((req, res) => {
  const expr = new URL(req.url ?? '/', 'http://x').searchParams.get('expr') ?? '';
  // js/code-injection, via node:http
  res.end(String(eval(expr)));
});
