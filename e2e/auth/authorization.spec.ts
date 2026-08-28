import { expect, test } from '@playwright/test';

test.describe('session and administrator boundaries @smoke', () => {
  test('an anonymous visitor meets the login wall and 401 admin API', async ({ page }) => {
    const response = await page.goto('/world');

    expect(response).not.toBeNull();
    await expect(page.getByRole('heading', { name: 'Run an airline' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    expect((await page.request.get('/api/admin/overview')).status()).toBe(401);
  });

  test.describe('a signed-in player', () => {
    test.use({ storageState: 'e2e/.auth/player.json' });

    test('is refused the console without an admin API request', async ({ page }) => {
      const adminRequests: string[] = [];
      const googleRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/admin/')) {
          adminRequests.push(request.url());
        }
        if (url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) {
          googleRequests.push(request.url());
        }
      });

      await page.goto('/admin');

      await expect(page.getByRole('heading', { name: 'Administrators only' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to the world' })).toBeVisible();
      expect(adminRequests).toEqual([]);
      expect(googleRequests).toEqual([]);
      expect((await page.request.get('/api/admin/overview')).status()).toBe(403);
    });
  });

  test.describe('a signed-in administrator', () => {
    test.use({ storageState: 'e2e/.auth/admin.json' });

    test('can open the console and its protected overview', async ({ page }) => {
      await page.goto('/admin');

      await expect(page.getByRole('link', { name: 'Admin console' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();
      expect((await page.request.get('/api/admin/overview')).status()).toBe(200);
    });
  });
});
