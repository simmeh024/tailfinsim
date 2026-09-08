import { expect, test } from '@playwright/test';

/**
 * A deliberately narrow harness check. Authenticated journeys belong to
 * E2E-03 and E2E-04; this proves E2E-01 is opening the built client through
 * the same Fastify origin as its API instead of a Vite development server.
 *
 * Since LANDING-01 the anonymous front door is the landing page rather than the
 * login wall (ADR-0028). The login wall still exists and is still what an
 * anonymous visitor gets on any app route — the second test holds that — but `/`
 * is now marketing, so this file checks both halves of the split.
 */

test('serves the landing page from the application origin @smoke', async ({ page }) => {
  const response = await page.goto('/');

  expect(response).not.toBeNull();
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(
    page.getByRole('heading', { name: 'Build an airline. Make it yours.' }),
  ).toBeVisible();

  // Both providers, in a real browser. The unit tests prove the page carries the
  // links; this proves the server serves them where a browser can reach them.
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Discord' })).toBeVisible();
});

test('actually paints the landing stylesheet @smoke', async ({ page }) => {
  /*
   * Half of the check that was missing when the landing page shipped unstyled —
   * and it is worth being exact about which half, because the obvious reading of
   * this test is wrong.
   *
   * **This does not test the CSP.** The policy lives in the Caddyfile, and this
   * suite drives Fastify directly with no Caddy in front, so a CSP regression
   * would sail straight past it. What guards that is
   * `deploy/verify-security-headers.mjs`, which refuses an inline `<style>` in
   * the landing document and requires `style-src 'self'` — asserted where the
   * policy is written rather than where it is served.
   *
   * What this *does* catch is the stylesheet not arriving or not applying at all:
   * an unserved route, a wrong path, a broken rule. Asserting a computed value
   * rather than the presence of a `<link>` is deliberate — a stylesheet that is
   * requested and then refused still has its tag in the DOM, so the tag proves
   * nothing. The paint does.
   */
  await page.goto('/');

  // The string form with an explicit type parameter, matching
  // `authorization.spec.ts`: this project's tsconfig gives e2e specs `node`
  // types and no DOM lib, so a callback touching `document` is untyped.
  const background = await page.evaluate<string>(`getComputedStyle(document.body).backgroundColor`);
  expect(background).toBe('rgb(6, 10, 18)');

  // A second property, from a different rule, so one lucky default cannot pass
  // this on its own.
  const headingTransform = await page.evaluate<string | null>(`
    (() => {
      const h1 = document.querySelector('h1');
      return h1 === null ? null : getComputedStyle(h1).textTransform;
    })()
  `);
  expect(headingTransform).toBe('uppercase');
});

test('advances the fleet carousel when its buttons are used @smoke', async ({ page }) => {
  /*
   * The carousel is the page's only scripted behaviour, so this doubles as the
   * proof that `/landing.js` is served, allowed by `script-src 'self'` and
   * actually running — a script the CSP refused would leave the arrows hidden
   * and this test red.
   *
   * Driven by the buttons rather than by waiting out the five-second
   * auto-advance: the same code path moves the slide either way, and sleeping
   * five seconds to watch a timer costs five seconds of every CI run for no
   * extra coverage.
   */
  await page.goto('/');

  // The arrows stay hidden until the script marks itself ready, so this
  // attribute is the signal that it ran at all.
  const carousel = page.locator('.fleet');
  await expect(carousel).toHaveAttribute('data-ready', 'true');

  const first = page.locator('.fleet__slide').first();
  await expect(first).not.toHaveAttribute('inert', /.*/);
  await expect(page.getByText('ATR 72-600')).toBeVisible();

  await page.getByRole('button', { name: 'Next aircraft' }).click();

  // The first slide steps out of the tab order and the second takes over.
  await expect(first).toHaveAttribute('inert', /.*/);
  await expect(page.locator('.fleet__slide').nth(1)).not.toHaveAttribute('inert', /.*/);

  await page.getByRole('button', { name: 'Previous aircraft' }).click();
  await expect(first).not.toHaveAttribute('inert', /.*/);
});

test('still shows the login wall to an anonymous visitor on an app route @smoke', async ({
  page,
}) => {
  // `/` became marketing; the login wall did not go away. Every other route is
  // still the SPA, and `RequireSession` still renders the wall in front of it.
  await page.goto('/world');

  await expect(page.getByRole('heading', { name: 'Run an airline' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Discord' })).toBeVisible();
});
