import { expect, test } from '@playwright/test';

function apiPath(url: string): string {
  return new URL(url).pathname;
}

test.describe('console freshness under API failures', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('keeps real overview figures visible, labels them stale, and recovers @smoke', async ({
    page,
  }) => {
    const firstOverview = page.waitForResponse(
      (response) => apiPath(response.url()) === '/api/admin/overview' && response.status() === 200,
    );
    await page.goto('/admin');
    const first = (await (await firstOverview).json()) as { counts: { worlds: number } };
    const worldCount = `${String(first.counts.worlds)} ${first.counts.worlds === 1 ? 'World' : 'Worlds'}`;
    await expect(page.getByRole('link', { name: worldCount, exact: true })).toBeVisible();

    let intercepted = 0;
    await page.route('**/api/admin/overview', async (route) => {
      intercepted += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.getByRole('button', { name: 'Refresh' }).click();

    await expect(page.getByText(/The last refresh failed/i)).toBeVisible();
    await expect(page.getByRole('link', { name: worldCount, exact: true })).toBeVisible();
    expect(intercepted).toBe(1);

    await page.unroute('**/api/admin/overview');
    const recovered = page.waitForResponse(
      (response) => apiPath(response.url()) === '/api/admin/overview' && response.status() === 200,
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await recovered;

    await expect(page.getByText(/The last refresh failed/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: worldCount, exact: true })).toBeVisible();
  });

  test('distinguishes a failed first overview load from stale data', async ({ page }) => {
    let intercepted = 0;
    await page.route('**/api/admin/overview', async (route) => {
      intercepted += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/admin');

    await expect(page.getByText('Could not load the overview.')).toBeVisible();
    await expect(page.getByText(/The last refresh failed/i)).toHaveCount(0);
    expect(intercepted).toBe(1);
  });

  test('keeps world health visible and labels it stale after a failed refresh', async ({
    page,
  }) => {
    const initialHealth = page.waitForResponse(
      (response) =>
        apiPath(response.url()) === '/api/admin/worlds/health' && response.status() === 200,
    );
    await page.goto('/admin/worlds');
    const health = (await (await initialHealth).json()) as {
      worlds: { name: string; tickDetail: string }[];
    };
    const world = health.worlds.find((entry) => entry.name === 'E2E Fixture World');
    expect(world).toBeDefined();
    await expect(page.getByText(world!.tickDetail, { exact: true })).toBeVisible();

    let intercepted = 0;
    await page.route('**/api/admin/worlds/health', async (route) => {
      intercepted += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { dispatchEvent(event: unknown): boolean };
        Event: new (type: string) => unknown;
      };
      Object.defineProperty(browser.document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      browser.document.dispatchEvent(new browser.Event('visibilitychange'));
      Object.defineProperty(browser.document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    });

    await expect(
      page.getByText(/The last refresh failed; the figures above are older than they look/i),
    ).toBeVisible();
    await expect(page.getByText(world!.tickDetail, { exact: true })).toBeVisible();
    expect(intercepted).toBe(1);
  });
});
