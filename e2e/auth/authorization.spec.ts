import { expect, test } from '@playwright/test';

import type { Page } from '@playwright/test';

const CONSOLE_MARKERS = ['Admin console'];

/**
 * SEC-11 intentionally has only these four browser checks. They prove what a
 * player can see and what their browser attempts; the full endpoint permission
 * matrix, ownership cases, and tampered IDs remain fast API-suite coverage.
 */
async function observeConsoleContentBeforeNavigation(page: Page): Promise<void> {
  await page.addInitScript(`
    (() => {
      const markers = ${JSON.stringify(CONSOLE_MARKERS)};
      const observed = new Set();
      const recordConsoleContent = () => {
        const pageText = document.body?.textContent ?? '';
        for (const marker of markers) {
          if (pageText.includes(marker)) observed.add(marker);
        }
        document.documentElement.dataset.e2eConsoleContent = [...observed].join(',');
      };

      new MutationObserver(recordConsoleContent).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      recordConsoleContent();
    })();
  `);
}

async function observedConsoleContent(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`
    (() => {
      const observed = document.documentElement.dataset.e2eConsoleContent;
      return observed === undefined || observed === '' ? [] : observed.split(',');
    })()
  `);
}

test.describe('session and administrator boundaries @smoke', () => {
  test('an anonymous visitor at the console meets the login wall without a console flash', async ({
    page,
  }) => {
    await observeConsoleContentBeforeNavigation(page);
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Run an airline' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin console' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);
    expect(await observedConsoleContent(page)).toEqual([]);
  });

  test.describe('a signed-in player', () => {
    test.use({ storageState: 'e2e/.auth/player.json' });

    test('is refused the console without an admin API request', async ({ page }) => {
      const adminRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/admin/')) adminRequests.push(request.url());
      });

      await page.goto('/admin');

      await expect(page.getByRole('heading', { name: 'Administrators only' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to the world' })).toBeVisible();
      expect(adminRequests).toEqual([]);
    });

    test('has no administration entry point in the player shell', async ({ page }) => {
      await page.goto('/fleet');

      const mainNavigation = page.getByRole('navigation', { name: 'Main' });
      await expect(page.getByText('E2E Player', { exact: true })).toBeVisible();
      await expect(page.getByText(/^build \d+$/)).toBeVisible();
      await expect(mainNavigation).toBeVisible();
      await expect(mainNavigation.getByRole('link', { name: /admin/i })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'admin', exact: true })).toHaveCount(0);
    });
  });

  test.describe('a signed-in administrator', () => {
    test.use({ storageState: 'e2e/.auth/admin.json' });

    test('reaches the console and its primary sections', async ({ page }) => {
      await page.goto('/admin');

      const sections = page.getByRole('navigation', { name: 'Admin sections' });
      await expect(page.getByRole('link', { name: 'Admin console' })).toBeVisible();
      await expect(sections).toBeVisible();
      for (const label of ['Overview', 'Worlds', 'Players', 'Audit log']) {
        await expect(sections.getByRole('link', { name: label, exact: true })).toBeVisible();
      }
    });
  });
});
