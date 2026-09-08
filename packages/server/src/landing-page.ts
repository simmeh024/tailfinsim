import { authFailureMessage, REGISTRATION_COPY } from '@tailfin/shared';

/**
 * Rendering the public landing document (LANDING-04).
 *
 * ## Why the server renders a "static" page at all
 *
 * ADR-0028 makes the landing page a static document whose funnel is two plain
 * anchors, so it works with no JavaScript. Two things on it nevertheless cannot
 * be written at author time:
 *
 * - **Whether this server creates accounts.** `ALLOW_REGISTRATION` is a per-box
 *   `.env` value. A page that promises *"New accounts are created
 *   automatically"* in front of a server that refuses them makes its last
 *   sentence a lie and the visitor's next experience a refusal.
 * - **Why a sign-in just failed.** The OAuth callback can only report a reason by
 *   redirecting to `/?auth_error=<code>`, and a failed attempt leaves no session
 *   cookie — so it lands on precisely this document. Before LANDING-04 there was
 *   nowhere to put it, and a refused sign-in bounced the visitor back to an
 *   unchanged page saying nothing at all.
 *
 * Both could have been done in the browser. Neither should be: an explanation
 * only a scripting-enabled visitor can read is one some visitors never get, and
 * the account-state line has to be true for everyone or it should not be on the
 * page.
 *
 * ## Why this is a module rather than ten lines in `app.ts`
 *
 * It writes HTML from a value that arrives in a query string, which is a shape
 * that deserves a test that runs everywhere. `app.test.ts` skips entirely
 * without `DATABASE_URL`, so a rendering bug there would only ever be caught in
 * CI — and only when somebody had already thought to look.
 */

/**
 * Escape text for HTML text content or a quoted attribute.
 *
 * **Second line of defence, not the first.** Every string that reaches the
 * document comes from a fixed table in `@tailfin/shared`, and the failure code
 * from the query string is used only as a *lookup key* — never as output, with
 * an unknown key falling back to a fixed sentence. Nothing attacker-controlled
 * is interpolated today.
 *
 * It exists because that is a property of the current callers rather than of
 * `fillSlot`, which looks equally happy to be handed a request value. The next
 * person to add a slot will read the signature long before the comment.
 *
 * `&` goes first, or it re-escapes the ampersands the later rules introduce.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Replace what sits between a pair of `tailfin:` markers, keeping the markers.
 *
 * Throws when the slot is absent, so a renamed or deleted marker is a **boot
 * failure** rather than a page that quietly stops telling the truth. That is the
 * whole risk of a template whose default content is already correct: a
 * substitution that silently did nothing looks exactly like one that worked.
 */
export function fillSlot(document: string, slot: string, content: string): string {
  const open = `<!--tailfin:${slot}-->`;
  const close = `<!--/tailfin:${slot}-->`;
  const from = document.indexOf(open);
  const to = document.indexOf(close);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`The landing page has no ${slot} slot; its template is out of step.`);
  }
  return document.slice(0, from + open.length) + content + document.slice(to);
}

/**
 * The landing document with this server's account policy written into it.
 *
 * `ALLOW_REGISTRATION` cannot change without a restart, so callers build this
 * **once at boot**: a request costs a lookup, not a render. The open state is
 * what the template already contains, so the common case substitutes a string
 * for the identical string — which is deliberate, because it keeps the file on
 * disk correct when opened on its own.
 */
export function renderLandingPage(template: string, allowRegistration: boolean): string {
  const copy = allowRegistration ? REGISTRATION_COPY.open : REGISTRATION_COPY.closed;
  return fillSlot(
    fillSlot(template, 'signin-title', escapeHtml(copy.title)),
    'signin-note',
    escapeHtml(copy.note),
  );
}

/** Every provider the document carries a button for, whether or not a box has it. */
const PROVIDER_BLOCKS = ['google', 'discord', 'twitch'] as const;

/**
 * Leave the buttons this instance has credentials for, and delete the rest
 * (AUTH-08).
 *
 * The document carries all three, which keeps the markup — and the inlined SVG
 * marks — where markup belongs and keeps the file rendering correctly when
 * opened on its own. The server removes what does not apply, which is the same
 * shape as the registration copy: the default content is right, the server
 * overrides.
 *
 * This existed as a bug before Twitch made it obvious. The page offered Google
 * and Discord to **every** box, including one with credentials for neither, so
 * a stranger on the front door could press a button that answers 503.
 * `LoginPage` has always asked the server — *"says sign-in is unconfigured
 * rather than offering a door that does not open"* — and the surface a stranger
 * actually meets did not. One list now, two renderers.
 *
 * An instance with no provider at all gets an empty card rather than a broken
 * one. That is a real state (production runs with no OAuth client of its own)
 * and it is the honest rendering of it.
 */
export function landingPageWithProviders(page: string, enabled: readonly string[]): string {
  let document = page;
  for (const provider of PROVIDER_BLOCKS) {
    const open = `<!--tailfin:provider-${provider}-->`;
    const close = `<!--/tailfin:provider-${provider}-->`;
    const from = document.indexOf(open);
    const to = document.indexOf(close);
    if (from === -1 || to === -1 || to < from) {
      // Loud, like every other slot: a renamed marker would silently start
      // showing a provider the box cannot serve.
      throw new Error(`The landing page has no ${provider} provider block.`);
    }
    if (enabled.includes(provider)) continue;
    document = document.slice(0, from) + document.slice(to + close.length);
  }
  return document;
}

/**
 * The world-status figures, written into the strip (LANDING-09).
 *
 * A number renders as a grouped figure carrying `data-count` — the raw integer
 * the count-up animation reads, so the script never parses formatted text back
 * into a number, and its absence is how the script knows to leave a figure
 * alone.
 *
 * `null` renders as an em-dash and keeps `--pending`, because **unknown is a
 * legitimate answer and zero is not the same claim.** A count that failed must
 * not become a "0" a visitor would read as a measurement — that is inventing a
 * statistic by a slightly more technical route than typing one.
 *
 * `en-US` grouping, pinned rather than taken from the environment, for the
 * reason the operations dashboard already pins it: a page where one figure
 * groups with commas and the next with dots is the inconsistency the design
 * language exists to prevent. The visitor's own locale is a LANDING i18n
 * question (M13-06), not a per-figure accident.
 */
function statMarkup(value: number | null): string {
  if (value === null) return '&mdash;';
  return `<span data-count="${escapeHtml(String(value))}">${escapeHtml(
    value.toLocaleString('en-US'),
  )}</span>`;
}

export function landingPageWithStats(
  page: string,
  stats: { airlines: number | null; aircraftTypes: number | null },
): string {
  return fillSlot(
    fillSlot(page, 'stat-airlines', statMarkup(stats.airlines)),
    'stat-aircraft-types',
    statMarkup(stats.aircraftTypes),
  );
}

/**
 * The same page with a failed sign-in explained inside the sign-in card.
 *
 * **The code is never rendered.** It is a query parameter, so it is whatever
 * anybody types; `authFailureMessage` maps a known code to a fixed sentence and
 * everything else to a fixed fallback. The only strings that reach the HTML are
 * ones this repository wrote, which is what makes writing into a document safe
 * here — and why the lookup deliberately does not fall back to printing the code
 * it did not recognise.
 *
 * The glyph is not decoration. App. H.4 requires status to be paired with a
 * shape rather than carried by hue, and this is the only status this page can
 * show.
 */
export function landingPageWithAuthError(page: string, code: string): string {
  const alert = [
    '<p class="lp-alert" role="alert">',
    '<span class="lp-alert__glyph" aria-hidden="true">!</span>',
    escapeHtml(authFailureMessage(code)),
    '</p>',
  ].join('');
  return fillSlot(page, 'auth-error', alert);
}
