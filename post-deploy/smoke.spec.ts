import { expect, test } from '@playwright/test';

import { POST_DEPLOY_SAFE_METHODS, postDeploySmoke } from './config';

interface VersionPayload {
  commit?: unknown;
  environment?: unknown;
}

function readVersionPayload(value: unknown): VersionPayload {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  return { commit: record.commit, environment: record.environment };
}

test('the deployed public surface renders the intended build without browser errors', async ({
  page,
}) => {
  const attemptedWrites: string[] = [];
  const browserErrors: string[] = [];

  // This is a transport boundary, not a naming convention. No page navigation,
  // asset fetch or XHR can mutate a deployed environment: Playwright aborts it
  // before it leaves the browser. There is no storage state or test identity.
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!POST_DEPLOY_SAFE_METHODS.has(request.method())) {
      attemptedWrites.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`page: ${error.message}`));

  const landingResponse = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(
    landingResponse,
    'the deployed origin did not answer the landing-page request',
  ).not.toBeNull();
  expect(landingResponse?.status(), 'the deployed landing page did not return HTTP 200').toBe(200);

  const versionResponse: { status: number; body: unknown } = await page.evaluate(async () => {
    const response = await fetch('/api/version', { headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.json() };
  });
  expect(versionResponse.status, 'the deployed version endpoint did not return HTTP 200').toBe(200);
  const version = readVersionPayload(versionResponse.body);
  expect(typeof version.commit, 'the version response has no commit').toBe('string');
  if (typeof version.commit === 'string') {
    expect(
      postDeploySmoke.expectedCommit.startsWith(version.commit.toLowerCase()),
      `expected deployed commit ${postDeploySmoke.expectedCommit}, received ${version.commit}`,
    ).toBe(true);
  }
  expect(version.environment, 'the deployed environment label is wrong').toBe(
    postDeploySmoke.expectedEnvironment,
  );

  /*
   * Three public surfaces now, not two (LANDING-01).
   *
   * Every branch ends in a **computed colour**, and that is the point of this
   * test rather than a flourish. This smoke is the only check in the repository
   * that loads a deployed page through Caddy in a real browser, so it is the only
   * one that can see the Content-Security-Policy — which lives in the Caddyfile,
   * is not installed by `deploy.sh`, and is invisible to every unit and e2e
   * suite. The landing page shipped once with an inline `<style>` the policy
   * refused: valid HTML, green deploy, healthy service, unstyled page. A colour
   * is what tells "served" from "served and allowed to paint".
   */
  const holdingHeading = page.getByRole('heading', { name: 'TAILFIN', exact: true });
  const landingHeading = page.getByRole('heading', {
    name: 'Build an airline. Make it yours.',
  });

  if (await holdingHeading.isVisible()) {
    // Production currently serves this surface. Its style is inline, so a
    // computed colour proves the stylesheet survived as well as the HTML.
    await expect(page).toHaveTitle('Tailfin — coming soon');
    await expect(page.getByText('Coming soon.')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(6, 10, 18)');
  } else if (await landingHeading.isVisible()) {
    // Dev's front door since LANDING-01. Its stylesheet is a separate
    // same-origin file, so the colour proves `/landing.css` was served *and*
    // allowed by `style-src 'self'`.
    await expect(page).toHaveTitle(/^Tailfin — build an airline/);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(6, 10, 18)');
    // Matched by shape rather than by provider, for the same reason as the app
    // branch below: which buttons appear is that box's `.env`.
    await expect(page.getByRole('link', { name: /^Continue with / }).first()).toBeVisible();
  } else {
    // Dev serves the app. The anonymous login wall proves the client bundle,
    // routing and its initial API call all rendered rather than a blank page.
    //
    // Matched by shape rather than by provider (AUTH-08): which buttons appear
    // is decided by that box's `.env`, and this check exists to prove the page
    // rendered — not to assert which credentials the environment happens to
    // hold. Pinning a provider here turns an ordinary configuration change into
    // a failed deploy.
    await expect(page).toHaveTitle('Tailfin');
    await expect(page.getByRole('link', { name: /^Continue with / }).first()).toBeVisible();
    await expect(page.getByRole('main')).toHaveCSS('background-color', 'rgb(19, 26, 36)');
  }

  expect(attemptedWrites, 'the smoke blocked a non-read-only browser request').toEqual([]);
  expect(browserErrors, 'the deployed page emitted browser errors while loading').toEqual([]);
});
