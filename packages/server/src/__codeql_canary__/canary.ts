/**
 * CANARY — DELETE. Not for merge.
 *
 * Two deliberate vulnerabilities, planted to prove the CodeQL workflow reads
 * Tailfin's own source rather than merely exiting zero. Zero findings on a clean
 * tree is indistinguishable from a scanner pointed at nothing.
 */
import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

export function registerCanary(app: FastifyInstance): void {
  app.get<{ Querystring: { expr?: string; file?: string } }>('/__canary', async (request) => {
    // js/code-injection
    const evaluated: unknown = eval(String(request.query.expr));
    // js/path-injection
    const contents = readFileSync(String(request.query.file), 'utf8');
    return { evaluated, contents };
  });
}
