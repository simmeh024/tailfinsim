import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REGISTRATION_COPY } from '@tailfin/shared';

import {
  fillSlot,
  landingPageWithAuthError,
  landingPageWithProviders,
  landingPageWithStats,
  renderLandingPage,
} from './landing-page';

/**
 * Rendering the public landing document (LANDING-04).
 *
 * Deliberately **not** in `app.test.ts`, which skips entirely without
 * `DATABASE_URL`. This writes HTML from a value that arrives in a query string;
 * a test for that should run on every machine and every `pnpm test`, not only on
 * a runner with Postgres attached.
 *
 * The real template is read from disk rather than mocked, because half of what
 * can break here is the document and the server disagreeing about a marker.
 */

const TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'landing', 'index.html'),
  'utf8',
);

describe('the account-state copy', () => {
  it('promises accounts when this server creates them', () => {
    const page = renderLandingPage(TEMPLATE, true);
    expect(page).toContain(REGISTRATION_COPY.open.title);
    expect(page).toContain(REGISTRATION_COPY.open.note);
    expect(page).not.toContain(REGISTRATION_COPY.closed.note);
  });

  it('says what actually happens when it does not', () => {
    /*
     * The failure this exists for: `ALLOW_REGISTRATION` defaults to false, and a
     * front door reading "New accounts are created automatically" in front of a
     * server that refuses them makes the page's last sentence a lie and the
     * visitor's next experience a refusal.
     */
    const page = renderLandingPage(TEMPLATE, false);
    expect(page).toContain(REGISTRATION_COPY.closed.title);
    expect(page).toContain(REGISTRATION_COPY.closed.note);
    expect(page).not.toContain(REGISTRATION_COPY.open.note);
    expect(page).not.toContain('created automatically');
  });

  it('takes the state from the argument, so nothing can bake it in', () => {
    // Same template, two documents. If these were ever equal the substitution
    // would have quietly become a no-op, which is the one failure a template
    // whose default is already correct can hide.
    expect(renderLandingPage(TEMPLATE, true)).not.toBe(renderLandingPage(TEMPLATE, false));
  });
});

describe('a refused sign-in', () => {
  const base = renderLandingPage(TEMPLATE, true);

  it('is silent until there is something to say', () => {
    // The slot is empty in the ordinary case: no empty alert box, no
    // `role="alert"` for a screen reader to announce nothing into.
    expect(base).not.toContain('lp-alert');
    expect(base).not.toContain('role="alert"');
  });

  it('explains a known code inside the card', () => {
    const page = landingPageWithAuthError(base, 'registration_closed');
    expect(page).toContain('role="alert"');
    expect(page).toContain('Tailfin is not open for new accounts yet.');
    // Inside the sign-in card, not floating at the top of a tall hero: the card
    // is what the visitor was interacting with, and the explanation has to be
    // read before the button that failed is pressed again.
    expect(page.indexOf('lp-alert')).toBeGreaterThan(page.indexOf('lp-signin__title'));
    expect(page.indexOf('lp-alert')).toBeLessThan(page.indexOf('lp-signin__buttons'));
  });

  it('pairs the colour with a shape', () => {
    // H.4: status is never carried by hue alone. This is the only status the
    // page can show, and it is shown to somebody who is already confused.
    const page = landingPageWithAuthError(base, 'state_mismatch');
    expect(page).toContain('lp-alert__glyph');
    expect(page).toContain('aria-hidden="true"');
  });

  it('falls back to a fixed sentence for a code it does not know', () => {
    const page = landingPageWithAuthError(base, 'nonsense');
    expect(page).toContain('Sign-in failed. Please try again.');
  });

  it('never renders the code it was given', () => {
    /*
     * The security property, and the reason the lookup does not print an
     * unrecognised code.
     *
     * `auth_error` is a query parameter: it is whatever anybody puts in a link.
     * A page that echoed it would be a reflected-XSS sink on the one document
     * every stranger reaches, served from the origin that holds the session
     * cookie. Nothing here is echoed — a known code selects a fixed sentence and
     * everything else selects a different fixed sentence.
     */
    const hostile = [
      '<img src=x onerror=alert(1)>',
      '"><script>alert(1)</script>',
      "');alert(1);//",
      '<svg/onload=alert(1)>',
      'javascript:alert(1)',
    ];

    for (const code of hostile) {
      const page = landingPageWithAuthError(base, code);
      expect(page, code).toContain('Sign-in failed. Please try again.');
      expect(page, code).not.toContain(code);
      // Nor any escaped fragment of it — the whole string is discarded, not
      // sanitised, which is a stronger property and the one worth asserting.
      expect(page, code).not.toContain('alert(1)');
      expect(page, code).not.toContain('&lt;img');
    }
  });

  it('leaves the rest of the document alone', () => {
    const page = landingPageWithAuthError(base, 'exchange_failed');
    expect(page).toContain('href="/api/auth/google"');
    expect(page).toContain('href="/api/auth/discord"');
    // The funnel is untouched: the buttons are still plain anchors, which is
    // what lets sign-in work with no JavaScript and no CSP exception.
    expect(page.length).toBeGreaterThan(base.length);
  });
});

describe('the slots themselves', () => {
  it('refuses a template that has lost one', () => {
    /*
     * The important failure mode. The template's default content is already the
     * correct open-state copy, so a substitution that silently did nothing would
     * look identical to one that worked — right up until `ALLOW_REGISTRATION` is
     * false on a real box, at which point the page lies.
     *
     * So a missing marker throws at boot rather than degrading.
     */
    const mangled = TEMPLATE.replace('<!--tailfin:signin-note-->', '<!--signin-note-->');
    expect(() => renderLandingPage(mangled, false)).toThrow(/signin-note/);
  });

  it('keeps its markers, so the same page can be filled again', () => {
    // `sendLanding` fills the error slot on a page whose registration slots are
    // already filled. That only works because filling preserves the markers.
    // Distinctive sentinels, not 'first' and 'second': the document's own prose
    // talks about the first paint and the first aircraft, and the first draft of
    // this test failed on its own comment.
    const once = fillSlot(TEMPLATE, 'signin-title', 'SLOT-ONE');
    const twice = fillSlot(once, 'signin-title', 'SLOT-TWO');
    expect(twice).toContain('<!--tailfin:signin-title-->SLOT-TWO<!--/tailfin:signin-title-->');
    expect(twice).not.toContain('SLOT-ONE');
  });

  it('escapes what it writes, whatever the caller hands it', () => {
    // Nothing reaches this with markup today. The guard is for the slot somebody
    // adds later, having read the signature rather than the comment above it.
    const page = fillSlot(TEMPLATE, 'signin-title', '<b>x</b>');
    expect(page).toContain('<b>x</b>');
    const escaped = renderLandingPage(TEMPLATE, true);
    expect(escaped).not.toContain('<b>');
  });
});

describe('the world-status figures', () => {
  const base = renderLandingPage(TEMPLATE, true);

  it('writes measured counts into the strip', () => {
    const page = landingPageWithStats(base, { airlines: 1247, aircraftTypes: 18 });
    // Grouped for a reader...
    expect(page).toContain('1,247');
    expect(page).toContain('>18<');
    // ...and raw for the animation, so nothing has to parse "1,247" back into a
    // number and get it wrong in a locale that groups with dots.
    expect(page).toContain('data-count="1247"');
    expect(page).toContain('data-count="18"');
  });

  it('renders an unknown as an em-dash, never as zero', () => {
    /*
     * The rule LANDING-09 exists for, at its sharpest. A count that failed is not
     * a count of zero: rendering `0 Airlines` would be presenting a fabricated
     * statistic, arrived at by a more technical route than typing one.
     */
    const page = landingPageWithStats(base, { airlines: null, aircraftTypes: null });
    expect(page).toContain('&mdash;');
    // The attribute, not the bare word: the document's own comment explains
    // `data-count`, and the first version of this assertion failed on it.
    expect(page).not.toContain('data-count="');
    expect(page).not.toContain('>0<');
  });

  it('lets one figure be known while the other is not', () => {
    // The catalogue count and the airline count come from different tables and
    // can fail independently; one missing must not blank the other.
    const page = landingPageWithStats(base, { airlines: null, aircraftTypes: 18 });
    expect(page).toContain('data-count="18"');
    expect(page).toContain('&mdash;');
  });

  it('renders a real zero as zero, because that is a measurement', () => {
    /*
     * The mirror of the rule above, and the reason `null` and `0` are different
     * types here rather than one nullable number treated as falsy. A brand new
     * instance genuinely has no airlines, and saying so is honest; the animation
     * skips it because counting up to zero is not a count.
     */
    const page = landingPageWithStats(base, { airlines: 0, aircraftTypes: 18 });
    expect(page).toContain('data-count="0"');
  });

  it('claims no liveness and publishes no growth delta', () => {
    const page = landingPageWithStats(base, { airlines: 1247, aircraftTypes: 18 });
    // The mock wants "Live now" and "+128 today" under these. A five-minute
    // cache cannot support the first, and the second publishes the product's
    // growth rate — a business disclosure nobody has decided to make.
    expect(page).not.toContain('Live now');
    expect(page).not.toMatch(/\+\d+ today/);
  });

  it('names the two metrics that are structurally zero rather than showing them', () => {
    const page = landingPageWithStats(base, { airlines: 1247, aircraftTypes: 18 });
    // Production has no worker (OPS-12), so both would read 0 for ever. They
    // keep their em-dash and their owning issue.
    expect(page).toContain('Flights airborne');
    expect(page).toContain('Passengers today');
    expect(page).toMatch(/Flights airborne\s*<span class="lp-todo">LANDING-09<\/span>/);
  });

  it('discloses nothing but the two integers', () => {
    // Aggregate-only is the whole basis on which this is safe to publish. No id
    // of any kind reaches the document.
    const page = landingPageWithStats(base, { airlines: 1247, aircraftTypes: 18 });
    expect(page).not.toMatch(/world[_-]?id/i);
    expect(page).not.toMatch(/airline[_-]?id/i);
    expect(page).not.toMatch(/player[_-]?id/i);
  });
});

describe('the sign-in buttons', () => {
  const base = renderLandingPage(TEMPLATE, true);

  it('offers only what this instance has credentials for', () => {
    /*
     * The bug Twitch exposed rather than caused. This document carried Google
     * and Discord buttons for *every* box, including one with credentials for
     * neither -- so a stranger on the front door could press a button that
     * answers 503. `LoginPage` has always asked the server; the surface a
     * stranger actually meets did not.
     */
    const page = landingPageWithProviders(base, ['google']);
    expect(page).toContain('Continue with Google');
    expect(page).not.toContain('Continue with Discord');
    expect(page).not.toContain('Continue with Twitch');
  });

  it('offers all three when all three are configured', () => {
    const page = landingPageWithProviders(base, ['google', 'discord', 'twitch']);
    expect(page).toContain('href="/api/auth/google"');
    expect(page).toContain('href="/api/auth/discord"');
    expect(page).toContain('href="/api/auth/twitch"');
  });

  it('leaves an empty card rather than a broken one when nothing is configured', () => {
    // A real state: production runs with no OAuth client of its own.
    const page = landingPageWithProviders(base, []);
    expect(page).not.toContain('Continue with');
    // The card and its heading survive, so the layout does not collapse.
    expect(page).toContain('lp-signin__buttons');
    expect(page).toContain('lp-signin__title');
  });

  it('keeps every button a plain anchor', () => {
    /*
     * The CTA's shape is a security property. `form-action 'self'` is in the
     * policy and OAuth needs no exception *because* the flow begins as a
     * top-level navigation from an anchor. A form post or a scripted redirect
     * would require weakening it.
     */
    const page = landingPageWithProviders(base, ['google', 'discord', 'twitch']);
    expect(page).not.toContain('<form');
    for (const provider of ['google', 'discord', 'twitch']) {
      expect(page).toContain(
        `<a class="lp-provider lp-provider--${provider}" href="/api/auth/${provider}">`,
      );
    }
  });

  it('refuses a template that has lost a provider block', () => {
    // Loud, like every other slot: a renamed marker would silently start
    // showing a provider the box cannot serve, which is the failure this
    // function exists to prevent.
    const mangled = TEMPLATE.replace('<!--tailfin:provider-twitch-->', '<!--provider-twitch-->');
    expect(() => landingPageWithProviders(mangled, ['google'])).toThrow(/twitch/);
  });
});
