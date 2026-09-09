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

  // Every configured provider, in a real browser. The unit tests prove the page
  // carries the links; this proves the server serves them where a browser can
  // reach them. `start-server.mjs` configures all three deliberately — see the
  // note there about why a missing one would weaken the fold assertions below.
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Discord' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Twitch' })).toBeVisible();
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
  expect(background).toBe('rgb(11, 16, 23)');

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
  const carousel = page.locator('.lp-fleet');
  await expect(carousel).toHaveAttribute('data-ready', 'true');

  const first = page.locator('.lp-fleet__slide').first();
  await expect(first).not.toHaveAttribute('inert', /.*/);
  await expect(page.getByText('ATR 72-600')).toBeVisible();

  await page.getByRole('button', { name: 'Next aircraft' }).click();

  // The first slide steps out of the tab order and the second takes over.
  await expect(first).toHaveAttribute('inert', /.*/);
  await expect(page.locator('.lp-fleet__slide').nth(1)).not.toHaveAttribute('inert', /.*/);

  await page.getByRole('button', { name: 'Previous aircraft' }).click();
  await expect(first).not.toHaveAttribute('inert', /.*/);
});

/**
 * The viewports the hero's above-the-fold claim is made at (LANDING-04).
 *
 * Stated rather than implied, because "above the fold" is meaningless without
 * them. 1280x720 is the one that matters: it is the tightest common laptop, it
 * is the band LANDING-10 predicts the mock breaks in first, and it is where the
 * first measurement put the sign-in card 58px *below* the fold.
 *
 * **Provider count is an input to this claim.** Each button costs 65px — 53 tall
 * plus a 12 gap, measured on dev at 1280x720 — so the fold budget shrinks by that
 * much every time a provider is added, and the assertion is only as honest as the
 * number of providers the fixture configures. At three it clears 1280x720 with
 * room; a fourth is the point to re-measure rather than assume.
 */
const FOLD_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'small laptop', width: 1280, height: 720 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

for (const { name, width, height } of FOLD_VIEWPORTS) {
  test(`puts the sign-in button above the fold on a ${name} @smoke`, async ({ page }) => {
    /*
     * The **button**, not the whole card. The card's last line is a footnote; the
     * button is the thing the hero exists to get pressed, and it is what survives
     * when an error alert pushes the card taller. Measuring the card here would
     * make the assertion fail for a reason nobody should act on.
     */
    await page.setViewportSize({ width, height });
    await page.goto('/');

    const bottom = await page.evaluate<number>(`
      (() => {
        const buttons = document.querySelectorAll('.lp-provider');
        const last = buttons[buttons.length - 1];
        return last === undefined ? Infinity : last.getBoundingClientRect().bottom;
      })()
    `);

    expect(
      bottom,
      `the sign-in button is ${String(Math.round(bottom))}px down a ${String(height)}px viewport`,
    ).toBeLessThanOrEqual(height);
    // And nothing scrolls sideways to achieve it.
    const overflows = await page.evaluate<boolean>(
      `document.documentElement.scrollWidth > window.innerWidth`,
    );
    expect(overflows, 'the page scrolls horizontally').toBe(false);
  });
}

test('shows enough of the next section to invite a scroll @smoke', async ({ page }) => {
  /*
   * The hero used to be exactly `100svh - header`, ending on a clean edge that
   * gave a visitor no reason to believe anything followed it. `--lp-peek` takes a
   * sliver back — but only out of the hero's *budget*, so the sliver exists only
   * when the hero is tall enough to be budget-driven rather than content-driven.
   *
   * **Asserted on a monitor, not a laptop lid, and that is the honest limit.**
   * The hero's content is 830-880px tall at desktop type sizes depending on the
   * font stack, so under roughly 1000px of viewport the content sets the height
   * and the peek is spent. That is the right way round: the peek and the
   * above-the-fold CTA compete for the same pixels, and a visitor who cannot
   * reach the button has a worse problem than one who has to guess that
   * scrolling works.
   *
   * At 1440x1200 the hero measures exactly its budget — 1072px of 1072 — which is
   * the condition the sliver depends on, with ~240px of slack before the content
   * could take it back.
   *
   * This was asserted at 1440x900 first and CI returned **-0.75**, where the same
   * page measured 49px on the machine it was written on. Same cause as the fold
   * assertions above: a wider font stack on the runner makes the content taller,
   * which on a 900px lid is exactly enough to consume the sliver. So the claim
   * moves to a viewport where it is true with margin rather than true on one
   * platform.
   */
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto('/');

  const visible = await page.evaluate<number>(`
    (() => {
      const next = document.querySelector('.lp-section');
      return next === null ? 0 : window.innerHeight - next.getBoundingClientRect().top;
    })()
  `);
  expect(visible, 'no part of the next section is on screen').toBeGreaterThan(16);
});

test('shows measured world figures, and settles the count on them @smoke', async ({ page }) => {
  /*
   * The strip, end to end: a real server, a real database, a real browser
   * (LANDING-09).
   *
   * Deliberately not asserting *which* numbers. The airline count is whatever
   * this harness's fixtures happen to have founded, and pinning it would make
   * every future fixture change break a landing-page test for no reason. What
   * matters is the property: every figure is either something the server
   * measured or an honest em-dash, and **never a fabricated zero**.
   *
   * The count-up is checked by where it *lands*. An animation that ended a digit
   * short, or that reformatted the value in a different locale on the way past,
   * would turn a real statistic into an approximate one — so the settled text
   * must equal the integer the server put in `data-count`, grouped the same way.
   */
  await page.goto('/');

  await expect(page.getByText('Aircraft types')).toBeVisible();

  // Give the animation its 1.1s and the safety timeout its margin.
  await page.waitForTimeout(1800);

  const figures = await page.evaluate<{ shown: string; count: string | null }[]>(`
    [...document.querySelectorAll('.lp-stat__value')].map((value) => {
      const counted = value.querySelector('[data-count]');
      return {
        shown: value.textContent.trim(),
        count: counted === null ? null : counted.getAttribute('data-count'),
      };
    })
  `);

  expect(figures).toHaveLength(4);

  for (const { shown, count } of figures) {
    if (count === null) {
      // Not measured: an em-dash, and nothing that could be read as a number.
      expect(shown).toBe('—');
    } else {
      // Measured: settled exactly on the server's integer, grouped for reading.
      expect(shown).toBe(Number(count).toLocaleString('en-US'));
    }
  }

  // At least one is real, or this test is asserting nothing.
  expect(figures.filter((f) => f.count !== null).length).toBeGreaterThan(0);

  // No delta line, and no liveness claim a five-minute cache cannot support.
  await expect(page.getByText('Live now')).toHaveCount(0);
  await expect(page.getByText(/\+\d+ today/)).toHaveCount(0);
});

test('tells the truth about accounts, from the server @smoke', async ({ page }) => {
  /*
   * This harness runs with `ALLOW_REGISTRATION=false` (see `start-server.mjs`),
   * which makes it the one place the **closed** state is exercised end to end —
   * through a real server, a real response and a real browser. The unit tests in
   * `landing-page.test.ts` cover the open state, which is what dev runs.
   *
   * The pairing is the point. A page that hardcoded the mock's promise would
   * pass every open-state test ever written and still lie here.
   */
  await page.goto('/');

  await expect(page.getByText(/sign-in is limited to existing players/)).toBeVisible();
  await expect(page.getByText(/New accounts are created automatically/)).toHaveCount(0);
  // The heading changes with it: "Start your airline" promises an account this
  // server will not create.
  await expect(page.getByRole('heading', { name: 'Sign in to Tailfin' })).toBeVisible();
});

test('explains a refused sign-in on the page it lands on @smoke', async ({ page }) => {
  /*
   * The regression LANDING-04 closes, end to end.
   *
   * A failed OAuth callback redirects to `/?auth_error=<code>`, and a failed
   * attempt leaves no session cookie — so it lands on the public landing
   * document. That document is static and its funnel carries no JavaScript, so
   * before this the reason had nowhere to go: the visitor bounced back to an
   * unchanged page that said nothing at all.
   *
   * Driven through the real URL rather than a unit call, because the thing worth
   * proving is that the query parameter survives the surface branch at `/` and
   * reaches the renderer.
   */
  await page.goto('/?auth_error=registration_closed');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Tailfin is not open for new accounts yet.');

  // Inside the card, above the buttons: read before the button that failed is
  // pressed again.
  await expect(page.locator('.lp-signin .lp-alert')).toHaveCount(1);

  // And the funnel still works while the error is on screen.
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});

test('does not echo a hostile auth_error into the page @smoke', async ({ page }) => {
  /*
   * `auth_error` is a query parameter on the one document every stranger
   * reaches, served from the origin that holds the session cookie. A page that
   * printed it would be a reflected-XSS sink there.
   *
   * Asserted in a real browser as well as in the unit test, because "the string
   * is absent from the HTML" and "the browser did not execute anything" are
   * different claims and only one of them can be made here.
   */
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await page.goto(`/?auth_error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);

  await expect(page.getByRole('alert')).toContainText('Sign-in failed. Please try again.');
  expect(dialogs, 'the page executed something from the query string').toEqual([]);
  expect(await page.locator('img[onerror]').count()).toBe(0);
});

test('stays legible and signable-up with every image blocked @smoke', async ({ page }) => {
  /*
   * LANDING-03's last acceptance criterion: the page degrades to a solid token
   * background if every image fails to load.
   *
   * Worth a real test rather than an eyeball, because the failure is not
   * hypothetical and not uniform — a corporate proxy that strips WebP, a
   * half-deployed origin, a phone on a train. The hero is a CSS background on a
   * pseudo-element, so when it fails there is nothing in the DOM to notice: the
   * headline simply sits on whatever colour is underneath, and if that colour
   * had been left transparent the whole first screen would be white text on
   * white.
   *
   * Aborting the requests rather than hiding the elements, so the browser takes
   * the same path it would on a real failure.
   */
  await page.route('**/*.{webp,png,jpg,jpeg,avif,gif,svg}', (route) => route.abort());
  await page.goto('/');

  // The ground the tokens promise, on both the page and the hero — the hero
  // paints its own so the letterboxed map never shows page black through it.
  const grounds = await page.evaluate<string[]>(`
    [
      getComputedStyle(document.body).backgroundColor,
      getComputedStyle(document.querySelector('.lp-hero')).backgroundColor,
    ]
  `);
  expect(grounds).toEqual(['rgb(11, 16, 23)', 'rgb(11, 16, 23)']);

  // The words survive, because none of them were ever in the artwork.
  await expect(
    page.getByRole('heading', { name: 'Build an airline. Make it yours.' }),
  ).toBeVisible();

  // And the funnel still works, which is the whole point of the criterion.
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Discord' })).toBeVisible();

  // A broken aircraft image still says which aircraft it was.
  await expect(page.getByText('ATR 72-600')).toBeVisible();
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
