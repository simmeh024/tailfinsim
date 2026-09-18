import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

const ENFORCED_CSP = /\{\$TAILFIN_CSP_HEADER[^}]*\}\s+"([^"]+)"/.exec(
  readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8'),
)?.[1];
if (ENFORCED_CSP === undefined) throw new Error('Deployed CSP policy not found.');

/** A real GLB: one textured triangle with a bufferView-backed, opaque magenta PNG. */
function texturedTriangleGlb(): Buffer {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z/D/PwAG/gL+DHWJ3gAAAABJRU5ErkJggg==',
    'base64',
  );
  const positions = Buffer.alloc(36);
  [
    [-1, -1, 0],
    [1, -1, 0],
    [0, 1, 0],
  ]
    .flat()
    .forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const texcoords = Buffer.alloc(24);
  [
    [0, 0],
    [1, 0],
    [0.5, 1],
  ]
    .flat()
    .forEach((value, index) => texcoords.writeFloatLE(value, index * 4));
  // The progress view starts from negative Z, so this winding faces its camera.
  const indices = Buffer.from([0, 0, 2, 0, 1, 0]);
  const binary = Buffer.concat([positions, texcoords, indices, Buffer.alloc(2), png]);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
        {
          buffer: 0,
          byteOffset: positions.length,
          byteLength: texcoords.length,
          target: 34962,
        },
        {
          buffer: 0,
          byteOffset: positions.length + texcoords.length,
          byteLength: indices.length,
          target: 34963,
        },
        {
          buffer: 0,
          byteOffset: positions.length + texcoords.length + indices.length + 2,
          byteLength: png.length,
        },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-1, -1, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      images: [{ bufferView: 3, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [
        {
          primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }],
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const binaryPadding = (4 - (binary.length % 4)) % 4;
  const totalLength = 12 + 8 + json.length + jsonPadding + 8 + binary.length + binaryPadding;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length + jsonPadding, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length + binaryPadding, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([
    header,
    jsonHeader,
    json,
    Buffer.alloc(jsonPadding, 0x20),
    binaryHeader,
    binary,
    Buffer.alloc(binaryPadding),
  ]);
}

const OWN_AIRLINE = {
  airline: {
    id: '33333333-4444-4555-8666-777777777777',
    worldId: '22222222-3333-4444-8555-666666666666',
    playerId: '00000000-0000-4000-8000-000000000201',
    kind: 'player',
    archetype: null,
    name: 'E2E Design Air',
    iataCode: 'ED',
    icaoCode: 'EDA',
    callsign: 'DESIGN',
    baseCountry: 'NL',
    logo: null,
    cash: 50_000_000,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-09-13T00:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-09-13T00:00:00.000Z',
  },
  rebrand: null,
};

const DEV_VERSION = {
  build: 1,
  commit: 'e2e-model-progress',
  environment: 'dev',
  startedAt: '2026-09-13T00:00:00.000Z',
  ref: null,
  deployedAt: null,
  serverTime: '2026-09-13T00:00:00.000Z',
};

test.describe('Design Studio model progress review', () => {
  test.use({ storageState: 'e2e/.auth/player.json' });

  test('keeps the draft while the unavailable dev model falls back and previews switch', async ({
    page,
  }) => {
    // The ordinary E2E server identifies itself as local. Intercepting this
    // response keeps the dev-only mode a browser concern, without exposing a
    // quarantined review artifact from the harness server or any live host.
    await page.route('**/api/version', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEV_VERSION) }),
    );
    await page.route('**/api/airlines/me', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(OWN_AIRLINE) }),
    );
    await page.route('**/api/dev/assets/aircraft/quarantine-a320neo-progress.glb', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/design');

    const modelProgress = page.getByRole('button', { name: 'Model progress', exact: true });
    await expect(modelProgress).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Latest aircraft model', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Latest model unavailable — showing an illustrative fleet render.' }),
    ).toBeVisible();

    const paintMap = page.getByRole('button', { name: 'Paint map', exact: true });
    await paintMap.click();
    await expect(paintMap).toHaveAttribute('aria-pressed', 'true');
    const showTools = page.getByRole('button', { name: 'Show tools', exact: true });
    if (await showTools.isVisible()) await showTools.click();
    await page.getByRole('button', { name: '+ Add fill layer', exact: true }).click();
    const showLayers = page.getByRole('button', { name: 'Show layers 4', exact: true });
    await expect(showLayers).toBeVisible();
    await showLayers.click();
    await expect(page.getByRole('button', { name: 'Hide layers 4', exact: true })).toBeVisible();
    await expect(page.getByLabel('Rename Fuselage base').last()).toBeVisible();

    await expect(
      page.getByText('Exact zone clipping · canonical side-profile authoring'),
    ).toBeVisible();
    await expect(page.getByLabel('Rename Fuselage base').last()).toBeVisible();

    await modelProgress.click();
    await expect(modelProgress).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Latest model unavailable — showing an illustrative fleet render.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide layers 4', exact: true })).toBeVisible();
  });

  test('loads embedded texture data under the enforced CSP with controls outside the canvas @smoke', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 430, height: 900 });
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.route('**/design', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': ENFORCED_CSP },
      });
    });
    await page.route('**/api/version', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(DEV_VERSION) }),
    );
    await page.route('**/api/airlines/me', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(OWN_AIRLINE) }),
    );
    await page.route('**/api/dev/assets/aircraft/quarantine-a320neo-progress.glb', (route) =>
      route.fulfill({ contentType: 'model/gltf-binary', body: texturedTriangleGlb() }),
    );

    await page.goto('/design');

    const stage = page.getByRole('group', {
      name: 'A320neo latest aircraft model with sample livery',
    });
    await expect(stage).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Tail detail', exact: true })).toBeEnabled();

    const [viewportBox, canvasBox, resetBox, tailBox] = await Promise.all([
      page.locator('.livery-true-preview__viewport').boundingBox(),
      page.locator('.livery-canvas').boundingBox(),
      page.getByRole('button', { name: 'Reset view', exact: true }).boundingBox(),
      page.getByRole('button', { name: 'Tail detail', exact: true }).boundingBox(),
    ]);
    expect(viewportBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(resetBox).not.toBeNull();
    expect(tailBox).not.toBeNull();
    for (const control of [resetBox!, tailBox!]) {
      expect(control.x).toBeGreaterThanOrEqual(canvasBox!.x);
      expect(control.x + control.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width);
      expect(
        control.y + control.height <= viewportBox!.y ||
          control.y >= viewportBox!.y + viewportBox!.height,
      ).toBe(true);
    }

    const showLayers = page.getByRole('button', { name: 'Show layers 3', exact: true });
    await expect(showLayers).toBeVisible();
    await showLayers.click();
    await expect(page.locator('.livery-layers')).toHaveCount(1);
    await expect(page.locator('.livery-layers-inline')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide layers 3', exact: true }).click();
    await expect(page.locator('.livery-layers')).toHaveCount(0);
    await expect(page.locator('.livery-layers-inline')).toHaveCount(0);
    const closedCanvasBox = await page.locator('.livery-canvas').boundingBox();
    expect(closedCanvasBox).not.toBeNull();
    expect(closedCanvasBox!.height).toBeGreaterThan(200);

    const paintMap = page.getByRole('button', { name: 'Paint map', exact: true });
    await paintMap.click();
    await expect(paintMap).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Model progress', exact: true }).click();
    await expect(stage).toHaveAttribute('data-state', 'ready');
    expect(
      consoleErrors.filter((message) =>
        /content security policy|blob:|wasm|couldn't load texture|texture.*(?:error|fail)/i.test(
          message,
        ),
      ),
    ).toEqual([]);
  });
});
