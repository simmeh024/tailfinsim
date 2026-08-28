import { expect, test } from '@playwright/test';

const FIXTURE_WORLD = 'E2E Fixture World';
const CREATED_WORLD = 'E2E Admin Created World';

interface OverviewResponse {
  counts: {
    players: number;
    worlds: number;
    admins: number;
    auditEntries: number;
  };
}

interface WorldSummary {
  id: string;
  name: string;
  speedMultiplier: number;
  inGameDate: string;
  pendingEvents: number;
}

interface WorldHealth {
  worldId: string;
  name: string;
  tick: 'no_events' | 'idle' | 'keeping_up' | 'behind' | 'stalled';
  tickDetail: string;
}

interface AuditEntry {
  action: string;
  subjectId: string | null;
}

const TICK_LABEL: Record<WorldHealth['tick'], string> = {
  no_events: 'Nothing scheduled',
  idle: 'Idle',
  keeping_up: 'Keeping up',
  behind: 'Behind',
  stalled: 'Stalled',
};

function plural(value: number, singular: string, pluralForm: string): string {
  return `${String(value)} ${value === 1 ? singular : pluralForm}`;
}

function apiPath(response: { url: () => string }): string {
  return new URL(response.url()).pathname;
}

test.describe('administrator console', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('renders the live console shell and overview counts @smoke', async ({ page }) => {
    const overviewResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/overview' && response.status() === 200,
    );
    await page.goto('/admin');

    const overview = (await (await overviewResponse).json()) as OverviewResponse;
    const sections = page.getByRole('navigation', { name: 'Admin sections' });

    await expect(page.getByRole('link', { name: 'Admin console' })).toBeVisible();
    await expect(sections).toBeVisible();
    for (const label of [
      'Overview',
      'Worlds',
      'Players',
      'Carriers',
      'System health',
      'Audit log',
    ]) {
      await expect(sections.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(sections.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await expect(
      page.getByRole('link', {
        name: new RegExp(`^${plural(overview.counts.players, 'Player', 'Players')}`),
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: plural(overview.counts.worlds, 'World', 'Worlds'),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: plural(overview.counts.admins, 'Administrator', 'Administrators'),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: new RegExp(
          `^${plural(overview.counts.auditEntries, 'Audit entry', 'Audit entries')}`,
        ),
      }),
    ).toBeVisible();
  });

  test('marks each console destination as the section in view', async ({ page }) => {
    await page.goto('/admin');
    const sections = page.getByRole('navigation', { name: 'Admin sections' });

    for (const [label, path] of [
      ['Worlds', '/admin/worlds'],
      ['Players', '/admin/players'],
      ['Carriers', '/admin/carriers'],
      ['System health', '/admin/system'],
      ['Audit log', '/admin/audit'],
      ['Overview', '/admin'],
    ]) {
      await sections.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(sections.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });

  test('shows the seeded world with database-backed health', async ({ page }) => {
    const worldsResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/worlds' && response.status() === 200,
    );
    const healthResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/worlds/health' && response.status() === 200,
    );
    await page.goto('/admin/worlds');

    const worlds = (await (await worldsResponse).json()) as { worlds: WorldSummary[] };
    const health = (await (await healthResponse).json()) as { worlds: WorldHealth[] };
    const seeded = worlds.worlds.find((world) => world.name === FIXTURE_WORLD);
    const seededHealth = health.worlds.find((world) => world.name === FIXTURE_WORLD);

    expect(seeded).toBeDefined();
    expect(seededHealth).toBeDefined();
    const row = page.getByRole('row', { name: new RegExp(FIXTURE_WORLD) });
    await expect(row).toContainText(seeded!.speedMultiplier.toFixed(2) + '×');
    await expect(row).toContainText(seeded!.inGameDate.slice(0, 10));
    await expect(row).toContainText(String(seeded!.pendingEvents));
    await expect(page.getByText(TICK_LABEL[seededHealth!.tick], { exact: true })).toBeVisible();
    await expect(page.getByText(seededHealth!.tickDetail, { exact: true })).toBeVisible();
  });

  test('creates a disposable world and records it in the audit log', async ({ page }) => {
    await page.goto('/admin/worlds');
    await expect(page.getByRole('heading', { name: 'Create a world' })).toBeVisible();

    await page.getByLabel('Name').fill(CREATED_WORLD);
    const creationResponse = page.waitForResponse(
      (response) =>
        apiPath(response) === '/api/admin/worlds' &&
        response.request().method() === 'POST' &&
        response.status() === 201,
    );
    await page.getByRole('button', { name: 'Create world' }).click();

    const created = (await (await creationResponse).json()) as { world: WorldSummary };
    await expect(page.getByRole('status')).toHaveText(`Created “${CREATED_WORLD}”, in staging.`);

    const auditResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/audit' && response.status() === 200,
    );
    await page.getByRole('link', { name: 'Audit log', exact: true }).click();

    const audit = (await (await auditResponse).json()) as { entries: AuditEntry[] };
    expect(
      audit.entries.some(
        (entry) => entry.action === 'world.created' && entry.subjectId === created.world.id,
      ),
    ).toBe(true);
    await expect(page.getByRole('row', { name: new RegExp(created.world.id) })).toContainText(
      'world.created',
    );
  });

  test('requires review before a speed change and an exact name before reset', async ({ page }) => {
    const worldsResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/worlds' && response.status() === 200,
    );
    await page.goto('/admin/worlds');

    const worlds = (await (await worldsResponse).json()) as { worlds: WorldSummary[] };
    const seeded = worlds.worlds.find((world) => world.name === FIXTURE_WORLD);
    expect(seeded).toBeDefined();

    const speedRequests: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/admin/worlds/${seeded!.id}/speed`
      ) {
        speedRequests.push(request.url());
      }
    });

    await page.getByRole('button', { name: `Manage ${FIXTURE_WORLD}` }).click();
    await page.getByLabel('New speed multiplier').fill('3');
    await page.getByRole('button', { name: 'Review change' }).click();

    await expect(page.getByRole('group', { name: 'Confirm the speed change' })).toBeVisible();
    expect(speedRequests).toEqual([]);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: `Reset “${FIXTURE_WORLD}”…` }).click();
    await page.getByLabel('Why').fill('e2e safety check');
    const reset = page.getByRole('button', { name: `Reset “${FIXTURE_WORLD}” permanently` });
    await page.getByLabel(new RegExp(`Type .${FIXTURE_WORLD}. to confirm`)).fill('wrong world');
    await expect(reset).toBeDisabled();

    await page.getByLabel(new RegExp(`Type .${FIXTURE_WORLD}. to confirm`)).fill(FIXTURE_WORLD);
    await expect(reset).toBeEnabled();
  });

  test('records a player view but hides it from the audit log by default', async ({ page }) => {
    await page.goto('/admin/players');
    await page.getByRole('link', { name: 'E2E Player', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'E2E Player' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Identities' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await expect(page.getByText(/The session token is never stored/i)).toBeVisible();

    const defaultAuditResponse = page.waitForResponse(
      (response) => apiPath(response) === '/api/admin/audit' && response.status() === 200,
    );
    await page.getByRole('link', { name: 'Audit log', exact: true }).click();
    await defaultAuditResponse;

    await expect(page.getByText('player.viewed', { exact: true })).toHaveCount(0);
    const includedAuditResponse = page.waitForResponse(
      (response) =>
        apiPath(response) === '/api/admin/audit' &&
        new URL(response.url()).searchParams.get('includeViews') === 'true' &&
        response.status() === 200,
    );
    await page.getByLabel('Include views').check();

    const includedAudit = (await (await includedAuditResponse).json()) as { entries: AuditEntry[] };
    expect(includedAudit.entries.some((entry) => entry.action === 'player.viewed')).toBe(true);
    expect(await page.getByText('player.viewed', { exact: true }).count()).toBeGreaterThan(0);
  });
});
