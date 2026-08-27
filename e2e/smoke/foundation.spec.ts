import { expect, test } from '@playwright/test';

/**
 * A deliberately narrow harness check. Authenticated journeys belong to
 * E2E-03 and E2E-04; this proves E2E-01 is opening the built client through
 * the same Fastify origin as its API instead of a Vite development server.
 */
test('serves the built login wall from the application origin @smoke', async ({ page }) => {
  const response = await page.goto('/');

  expect(response).not.toBeNull();
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { name: 'Run an airline' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});
