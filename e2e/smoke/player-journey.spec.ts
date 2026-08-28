import { expect, test } from '@playwright/test';

test.describe('signed-in player journey @smoke', () => {
  test.use({ storageState: 'e2e/.auth/player.json' });

  test('opens the founding desk for a player without an airline and retains an auth error', async ({
    page,
  }) => {
    await page.goto('/?auth_error=access_denied');

    await expect(page).toHaveURL(/\/found\?auth_error=access_denied$/);
    await expect(page.getByRole('heading', { name: 'What’s your airline called?' })).toBeVisible();
  });

  test('keeps the signed-in shell and build identity through client navigation', async ({
    page,
  }) => {
    const versionResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/version' && response.status() === 200,
    );
    await page.goto('/fleet');

    const version = (await versionResponse).json() as Promise<{
      build: number;
      environment: string;
    }>;
    await expect(page.getByRole('heading', { name: 'Fleet' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByLabel('Status')).toBeVisible();
    await expect(page.getByText('E2E Player', { exact: true })).toBeVisible();

    const build = await version;
    await expect(page.getByText(build.environment, { exact: true })).toBeVisible();
    await expect(page.getByText(`build ${String(build.build)}`, { exact: true })).toBeVisible();

    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.getByRole('link', { name: 'Network', exact: true }).click();

    await expect(page).toHaveURL(/\/network$/);
    await expect(page.getByRole('heading', { name: 'Network' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  });
});

test.describe('sign out @smoke', () => {
  // Signing out revokes the server-side session, so it deliberately gets its
  // own fixture rather than racing specs that use player.json.
  test.use({ storageState: 'e2e/.auth/logout-player.json' });

  test('returns the player to the login wall and clears the signed-in shell', async ({ page }) => {
    await page.goto('/fleet');
    await expect(page.getByText('E2E Sign-out Player', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page.getByRole('heading', { name: 'Run an airline' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByText('E2E Sign-out Player', { exact: true })).toHaveCount(0);
  });
});
