import { expect, test } from '@playwright/test';

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

    const showTools = page.getByRole('button', { name: 'Show tools', exact: true });
    if (await showTools.isVisible()) await showTools.click();
    await page.getByRole('button', { name: '+ Add fill layer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Layers 4', exact: true })).toBeVisible();
    await expect(page.getByLabel('Rename Fuselage base').last()).toBeVisible();

    const paintMap = page.getByRole('button', { name: 'Paint map', exact: true });
    await paintMap.click();
    await expect(paintMap).toHaveAttribute('aria-pressed', 'true');
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
    await expect(page.getByRole('button', { name: 'Layers 4', exact: true })).toBeVisible();
  });
});
