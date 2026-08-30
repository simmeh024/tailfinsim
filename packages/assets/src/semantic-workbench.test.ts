import { once } from 'node:events';
import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseSemanticWorkbenchArguments,
  startSemanticWorkbenchServer,
  type SemanticWorkbenchPayload,
} from './semantic-workbench';

const servers: Awaited<ReturnType<typeof startSemanticWorkbenchServer>>[] = [];
afterEach(async () => {
  for (const running of servers.splice(0)) {
    running.server.close();
    await once(running.server, 'close');
  }
});

function payload(): SemanticWorkbenchPayload {
  return {
    model: Buffer.from('glTF-fixture'),
    app: Buffer.from('document.body.dataset.loaded="true";'),
    inventorySha256: 'a'.repeat(64),
    operationId: 'candidate-1',
    inventory: {
      format: 'tailfin-meshy-semantic-inventory',
      operationId: 'candidate-1',
      derivativeSha256: 'b'.repeat(64),
      components: [{ componentId: 'review_component_001', triangles: 1 }],
    },
  };
}

function requestWithHost(port: number, hostHeader: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: '127.0.0.1', port, path: '/', headers: { Host: hostHeader } },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('local semantic review workbench boundary', () => {
  it('parses only one candidate and a bounded loopback port', () => {
    expect(parseSemanticWorkbenchArguments(['--', '--operation', 'candidate-1'])).toEqual({
      operationId: 'candidate-1',
      port: 4183,
    });
    expect(
      parseSemanticWorkbenchArguments(['--operation', 'candidate-4', '--port', '49123']),
    ).toEqual({ operationId: 'candidate-4', port: 49123 });
    for (const args of [
      [],
      ['--operation', 'candidate-5'],
      ['--operation', 'candidate-1', '--port', '80'],
      ['--operation', 'candidate-1', '--port', '65536'],
      ['--operation', 'candidate-1', '--host', '0.0.0.0'],
      ['--operation', 'candidate-1', '--operation', 'candidate-2'],
    ]) {
      expect(() => parseSemanticWorkbenchArguments(args)).toThrow();
    }
  });

  it('serves four no-store GET routes on the exact loopback host and refuses mutations', async () => {
    const running = await startSemanticWorkbenchServer(payload(), 0);
    servers.push(running);
    const root = `http://127.0.0.1:${String(running.port)}`;
    for (const [path, type] of [
      ['/', 'text/html'],
      ['/app.js', 'text/javascript'],
      ['/model.glb', 'model/gltf-binary'],
      ['/inventory.json', 'application/json'],
    ]) {
      const response = await fetch(`${root}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
    expect((await fetch(`${root}/missing`)).status).toBe(404);
    expect((await fetch(`${root}/`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(await requestWithHost(running.port, `localhost:${String(running.port)}`)).toBe(404);
    const inventory = (await (await fetch(`${root}/inventory.json`)).json()) as Record<
      string,
      unknown
    >;
    expect(inventory.reportSha256).toBe('a'.repeat(64));
  });
});
