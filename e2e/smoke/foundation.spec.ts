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
  // Both providers, in a real browser. The unit tests prove the page renders
  // what the server reports; this proves the server reports both when both are
  // configured (AUTH-08).
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Discord' })).toBeVisible();
});
