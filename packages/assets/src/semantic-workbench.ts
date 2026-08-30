import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { meshyArchiveDirectory } from './meshy-archive';
import { readBoundedMeshyBytes, readBoundedMeshyInput } from './meshy-preflight';
import { MESHY_SEMANTIC_TARGETS } from './meshy-semantic-inventory';
import { meshyRunDatabasePath } from './meshy-store';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const SemanticInventory = z
  .object({
    format: z.literal('tailfin-meshy-semantic-inventory'),
    formatVersion: z.literal(1),
    derivativeSha256: Digest,
    operationId: z.string().regex(/^candidate-[1-4]$/),
    state: z.literal('quarantine'),
    semanticAssignmentsMade: z.literal(false),
    coordinateSystem: z.literal('+X right, +Y up, -Z forward'),
    coordinateUnits: z.literal('metres'),
    components: z
      .array(
        z
          .object({
            componentId: z.string().regex(/^review_component_\d{3}$/),
            triangles: z.number().int().positive(),
            side: z.enum(['left', 'right', 'centre', 'crosses_centre']),
            requiresManualTriangleLevelReview: z.boolean(),
          })
          .passthrough(),
      )
      .min(1)
      .max(256),
  })
  .passthrough();

export interface SemanticWorkbenchPayload {
  model: Buffer;
  inventory: Record<string, unknown>;
  inventorySha256: string;
  operationId: string;
  app: Buffer;
}

const PAGE = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tailfin semantic review workbench</title><style>
:root{color-scheme:dark;font:14px Inter,system-ui,sans-serif;background:#09111a;color:#edf4fb}*{box-sizing:border-box}body{margin:0}header{padding:14px 18px;border-bottom:1px solid #294057;background:#101c29}h1{font-size:20px;margin:0 0 5px}.warning{color:#ffc56e;margin:0}main{display:grid;grid-template-columns:minmax(600px,1fr) 350px;height:calc(100vh - 78px)}section{min-width:0;display:flex;flex-direction:column}.toolbar{padding:8px 12px;background:#132334;border-bottom:1px solid #294057;display:flex;gap:6px;flex-wrap:wrap}button,select,input{background:#182c3f;color:#edf4fb;border:1px solid #49657c;border-radius:4px;padding:7px}button:hover,button:focus-visible{border-color:#72b7ef}button[aria-pressed="true"]{background:#275374;border-color:#72b7ef}button.primary{background:#17659a}canvas{width:100%;height:100%;min-height:450px;touch-action:none;background:#dce5ec}aside{overflow:auto;border-left:1px solid #294057;background:#0f1b27;padding:14px}.field{margin:0 0 12px}.field label{display:block;color:#a9c1d5;margin-bottom:5px}.field input,.field select{width:100%}.stats{padding:10px;background:#172839;border-radius:5px;white-space:pre-wrap}.hint{color:#abc0d2;line-height:1.45}.status{padding:9px;border-left:3px solid #f8b34c;background:#192a38}.components{max-height:190px;overflow:auto;border:1px solid #294057}.components button{width:100%;text-align:left;border:0;border-bottom:1px solid #294057;border-radius:0}.components button.active{background:#275374}.views{display:flex;gap:4px;flex-wrap:wrap}@media(max-width:900px){main{grid-template-columns:1fr;height:auto}aside{border-left:0}canvas{height:58vh}}
</style></head><body><header><h1>Aircraft semantic review workbench</h1><p class="warning">PRIVATE QUARANTINE · selections are review evidence, never automatic asset admission.</p></header><main><section><div class="toolbar"><div class="views" aria-label="Canonical camera views"></div><button id="isolate" aria-pressed="false">Isolate component</button><button id="wireframe" aria-pressed="false">Show topology</button><button id="whole">Assign whole component</button><button id="clear-component">Clear component</button><button id="reset-draft">Reset local draft</button><button id="export" class="primary">Download review JSON</button><input id="import" type="file" accept="application/json" aria-label="Import review JSON"></div><canvas aria-label="Semantic triangle selection viewport"></canvas></section><aside><div id="status" class="status">Loading verified evidence…</div><div class="field"><label for="target">Active semantic target</label><select id="target"></select></div><div class="field"><label for="finding">Finding status</label><select id="finding"><option value="unreviewed">Unreviewed</option><option value="present">Present</option><option value="missing_requires_modeling">Missing — requires modeling</option><option value="not_applicable">Not applicable (optional only)</option></select></div><div class="field"><label for="rationale">Rationale for missing/not applicable</label><input id="rationale" maxlength="500"></div><div class="field"><label for="reviewer">Reviewer</label><input id="reviewer" value="local-operator" maxlength="80"></div><div class="field"><label for="angle">Shift-click flood angle: <output id="angle-value">25°</output></label><input id="angle" type="range" min="1" max="120" value="25"></div><p class="hint">Click a face to assign it. Alt-click clears. Shift-click flood-selects edge-connected faces within the normal-angle threshold. Whole-component assignment is intended for reviewed detached parts only. Drafts autosave only in this browser and exact candidate version.</p><div id="stats" class="stats"></div><h2>Components</h2><div id="components" class="components"></div></aside></main><script type="module" src="/app.js"></script></body></html>`);

function send(response: ServerResponse, status: number, body: Buffer, contentType: string) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}

/** Strict loopback-only GET surface; no uploads, writes, directory access or external resources. */
export function startSemanticWorkbenchServer(
  payload: SemanticWorkbenchPayload,
  port: number,
  host = '127.0.0.1',
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const inventory = Buffer.from(
      canonicalJson({ ...payload.inventory, reportSha256: payload.inventorySha256 }),
    );
    const server = createServer((request, response) => {
      try {
        const expectedHost = `127.0.0.1:${String((server.address() as { port: number }).port)}`;
        if (request.method !== 'GET' || request.headers.host !== expectedHost) throw new Error();
        const pathname = new URL(request.url ?? '', `http://${expectedHost}`).pathname;
        const route = new Map<string, [Buffer, string]>([
          ['/', [PAGE, 'text/html; charset=utf-8']],
          ['/app.js', [payload.app, 'text/javascript; charset=utf-8']],
          ['/model.glb', [payload.model, 'model/gltf-binary']],
          ['/inventory.json', [inventory, 'application/json; charset=utf-8']],
        ]).get(pathname);
        if (!route) throw new Error();
        send(response, 200, route[0], route[1]);
      } catch {
        send(response, 404, Buffer.from('Unavailable or refused.'), 'text/plain; charset=utf-8');
      }
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Workbench refused.'));
      resolve({ server, port: address.port });
    });
  });
}

export function parseSemanticWorkbenchArguments(argv: readonly string[]) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !['--operation', '--port'].includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('Invalid semantic workbench options.');
    }
    options.set(key, value);
  }
  if (!/^candidate-[1-4]$/.test(options.get('--operation') ?? ''))
    throw new Error('One recorded candidate operation is required.');
  const portText = options.get('--port') ?? '4183';
  if (!/^[0-9]{4,5}$/.test(portText)) throw new Error('Invalid loopback port.');
  const port = Number(portText);
  if (port < 1024 || port > 65_535) throw new Error('Invalid loopback port.');
  return { operationId: options.get('--operation')!, port };
}

export async function loadSemanticWorkbenchPayload(
  repository: string,
  operationId: string,
  app: Buffer,
): Promise<SemanticWorkbenchPayload> {
  const archiveRoot = meshyArchiveDirectory(meshyRunDatabasePath(repository));
  const inventoryBytes = Buffer.from(
    await readBoundedMeshyInput(
      join(archiveRoot, `${operationId}-semantic-inventory-v1.json`),
      1024 * 1024,
    ),
  );
  const inventory = SemanticInventory.parse(JSON.parse(inventoryBytes.toString('utf8')) as unknown);
  if (inventory.operationId !== operationId) throw new Error('Workbench inventory changed.');
  const model = await readBoundedMeshyBytes(
    join(archiveRoot, `correction-${inventory.derivativeSha256}.glb`),
    64 * 1024 * 1024,
  );
  if (sha256(model) !== inventory.derivativeSha256)
    throw new Error('Workbench derivative changed.');
  return {
    model,
    inventory,
    inventorySha256: sha256(inventoryBytes),
    operationId,
    app,
  };
}

export const semanticWorkbenchTargets = MESHY_SEMANTIC_TARGETS;
