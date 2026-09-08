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
