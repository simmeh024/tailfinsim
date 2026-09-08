# ADR-0028: The public landing surface

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** @simmeh024
- **Constrains:** LANDING-02 … LANDING-14, and any future public page (M12-02's
  `/airlines/{slug}`)

## Context

There are two public surfaces in this repository and neither is a landing page.

`packages/web/holding/index.html` is what `tailfinsim.com` actually serves: a self-contained
coming-soon document whose whole design is stated in its own comment — _"Inline so the page makes
zero external requests: no fonts, no CDN, no analytics. One document, one paint."_ It is chosen at
runtime by `WEB_SURFACE`, which is unset on production.

`LoginPage.tsx` is the sign-in card, reachable only where `WEB_SURFACE=app` — which is dev.
`RequireSession` renders it in place of the app for anyone without a session, and is explicit that
this is _"a **user-interface** gate, not a security boundary."_

So "the landing page" had no obvious home, and picking wrong is expensive in both directions: it
either replaces a production document that has a hash-pinned CSP entry, or it becomes a route inside
a client-rendered SPA that production does not serve at all.

## Decision

### 1. The landing page is a static document, served at `/landing` on every surface

Not a route inside the SPA. Since 2026-09-08 it is additionally the front door at `/` on the `app`
surface — see below; production, which runs `holding`, is unchanged.

**Static rather than a SPA route.** A public route inside the SPA would require `WEB_SURFACE=app`
on production, which promotes the entire game client to the public — an OPS decision nobody has
taken, and one this milestone has no business forcing as a side effect of shipping a marketing page.
It would also hand crawlers an empty root (LANDING-12 owns OpenGraph, and OG on an empty div is
nothing), and put the SPA bundle in front of the first paint that LANDING-11 is trying to keep fast.

**`/landing` is its stable path**, and it keeps working on every surface. It is what made the page
reviewable before it was anybody's front door, and it stays the canonical URL — nothing about the
document assumes where it is mounted.

**It is also the front door on the `app` surface**, added 2026-09-08 at the user's request so dev
shows it at `/`. The objection that made this non-obvious — a returning player must not be made to
walk through a sales page to reach their airline — is answered rather than accepted: `/` branches on
whether a session cookie is present, serving the SPA when it is and the landing page when it is not.
`IndexRedirect` is untouched, so a signed-in player still resolves to `/found` or `/world` with the
OAuth error query string intact.

That branch tests cookie **presence, not validity**, deliberately. It is the same class of decision
as `RequireSession` — _"a user-interface gate, not a security boundary"_ — and it fails harmlessly:
a stale or forged cookie gets the SPA, whose own session check then shows the login wall. Nothing is
disclosed either way, because both documents are public and neither carries player data. Validating
the token here would put a database read in front of the first paint of every anonymous visit, which
is the cost LANDING-11 exists to avoid.

**Production is unaffected**, because it runs the `holding` surface. The switchover there is still
decision 4's launch decision, and it did not happen by side effect.

**On every surface**, because the landing page's whole job is to be reachable by a stranger. Gating
it behind the surface flag would reintroduce the problem it exists to solve.

### 2. The funnel is two plain links, so it never depends on JavaScript

The entire call to action is `<a href="/api/auth/google">` and `<a href="/api/auth/discord">`. Both
routes are registered by `auth/routes.ts` on **every** surface, independent of `WEB_SURFACE` and of
whether a client is built.

This is the fact that makes the whole decision cheap. A zero-JS static document can carry a working
sign-in funnel, so none of LANDING-11's budget has to be spent to make the page functional, and
nothing about the page depends on the SPA existing.

**Both providers are offered, each in its own brand colour** — Google blue `#4285f4`, Discord
blurple `#5865f2` — with the official marks inlined as SVG paths so the document still makes no
external request.

That **reverses, for this surface only, a decision recorded in `LoginPage.tsx`**, which uses
typographic glyphs and says why: _"reproducing Google's and Discord's marks correctly means their
brand guidelines, their exact assets and their colours, which is a licensing question and a second
visual language on a page that has one."_ Both halves of that were right about the in-app login and
are wrong about the front door. A stranger deciding whether to trust an unknown site reads the
provider button before the copy, and an unbranded button is the one people hesitate over; and the
"second visual language" objection does not hold on a marketing page whose job is to be legible to
someone who has never seen Tailfin. Google and Discord both publish sign-in branding guidelines that
permit the marks in exactly this use.

`LoginPage.tsx` is deliberately **not** changed here — it is a different surface with a different
audience, seen only by someone already inside. If the two should converge, that is LANDING-13's call
when it owns the post-click journey, not a change to make in passing.

**Amended 2026-09-08: the page now has one script, and it is not in the funnel.** LANDING-06's fleet
carousel needs JavaScript — auto-advance and arrow controls cannot be expressed in CSS — so
`/landing.js` exists. Three properties keep decision 2 true rather than merely almost true:

- **Same-origin, never inline.** `script-src` is `'self'` with _no_ hashes, so an inline `<script>`
  would be refused outright. The failure would be worse than the stylesheet's: not an ugly page but
  dead controls, with every gate green. `verify-security-headers.mjs` now refuses an inline
  `<script>` in this document for exactly that reason.
- **`defer`, so it never blocks the first paint.** LANDING-11's budget is unaffected by a 2 kB file
  fetched after the document.
- **The page works without it.** The first aircraft renders as a static illustration, the arrows stay
  hidden until the script marks itself ready — a control that does nothing is worse than no control —
  and both sign-in links are ordinary anchors. A visitor with scripting off loses movement, not the
  ability to sign up.

### 3. `RequireSession` is not touched, and no public route enters the SPA

`App.tsx` wraps the whole route table deliberately: _"Gating route by route means every new route is
a chance to forget one, and the first forgotten one is the bug nobody notices."_

That reasoning still holds, and this decision means it does not have to be tested. There is no public
SPA route, so there is no allowlist to maintain and no next-route-beside-it to forget. The issue
allowed for an explicit allowlist if a public route landed in the SPA; not needing one is strictly
better.

### 4. The holding page is retained, and the switchover has two named conditions

`packages/web/holding/index.html` keeps serving `/` on production. The landing page does **not**
silently become the front door, and that is a decision rather than caution:

- **Production has no auth keys.** There is no Google OAuth application configured on production
  today — dev has one, production has none. A landing page at `/` would put a large "Continue with
  Google" button on the front door that cannot possibly work. The app already refuses to do this to
  people (`session-ui.test.tsx`: _"says sign-in is unconfigured rather than offering a door that
  does not open"_) and the front door must not be the exception.
- **Nobody has decided to launch.** The holding page says "coming soon" because that is true.
  Replacing it is a launch, and a launch is the user's call, not a side effect of merging a
  milestone.

**The switchover is therefore: production auth is configured, and someone decides to open the doors.**
At that point it is one `if` in `app.ts` and a CSP hash — no rework, because nothing about the
document assumes its path. The holding page is retired at that moment, not before.

### 5. Consequences handed to other issues, not taken here

- **CSP — corrected 2026-09-08, and the correction is the interesting part.** This bullet
  originally said the landing document's inline `<style>` needed its own `sha256-` entry, handed
  that to LANDING-11, and claimed `/landing` was _"reviewable on dev, where the policy is not
  enforced the same way"_. **That last claim was simply wrong.** Dev enforces the same policy, and
  `style-src` is `'self'` plus **the holding page's** hash — so the landing page shipped to dev and
  rendered completely unstyled.

  Nothing caught it. The build passed, the deploy passed, the health check passed, and the
  post-deploy browser smoke passed, because that smoke asserts the _front door_ renders and the
  front door is still the holding page. It was reviewed over `file://`, which has no CSP at all.

  The fix is not a hash. **The stylesheet is a same-origin file, `/landing.css`, which
  `style-src 'self'` already allows** — so this ADR needs no CSP change now, and neither does any
  of the thirteen LANDING issues still to touch those styles. A hash would have made every future
  CSS edit require a manual Caddy change, because CLAUDE.md is explicit that `deploy.sh` and
  `deploy-dev.sh` do not install Caddy config or reload the edge; the styles would have silently
  stopped applying each time until somebody remembered. A trap that springs on every edit is worse
  than the one request it saves.

  The holding page's _"zero external requests: no fonts, no CDN, no analytics"_ property is kept
  intact: one same-origin file on the same connection is not a third party, which is what that
  sentence was protecting against.

  Two tests now hold the line — one asserting the document carries no inline `<style>` or `style=`
  attribute, one asserting its only stylesheet is same-origin.

- **The numbers.** The mock shows 21,547 airlines and 2.98M passengers. Those are invented, and the
  skeleton ships the shape with the figures absent rather than fabricated — LANDING-09 is titled
  _"Real numbers, or no numbers"_ and a marketing page that ships fake statistics is lying to a
  visitor about how busy the game is. That kind of lie survives to launch precisely because everyone
  remembers it as placeholder copy.
- **The map.** LANDING-05's world map is an empty frame with a named owner, not a decorative
  stand-in. A fake map invites nobody to build the real one.

## Component structure

The sections LANDING-04 … LANDING-09 build into, in document order. Each is delimited by a comment
naming its issue, so the milestone's issues do not collide in one undifferentiated file:

| Section               | Owner                    | Ships today                         |
| --------------------- | ------------------------ | ----------------------------------- |
| Header and nav        | LANDING-02 (design), -13 | Structure, working sign-in link     |
| Hero                  | **LANDING-04**           | Headline, lede, four pillars, CTA   |
| World map             | **LANDING-05**           | Placeholder frame                   |
| Fleet / network / ops | **LANDING-06**           | Three cards, placeholder figures    |
| World keeps running   | **LANDING-07**           | Panel, placeholder live-flight card |
| Progression           | **LANDING-08**           | Not yet present                     |
| World status          | **LANDING-09**           | Shape only, figures absent          |
| Footer                | LANDING-02               | Complete                            |

## Consequences

- A stranger can reach exactly one public page, and it fetches nothing. There is no unauthenticated
  API caller introduced by this ADR — LANDING-09 owns that surface if it needs one.
- A signed-in visitor never sees marketing, because the landing page is not at `/` on the app
  surface and `IndexRedirect` is unchanged.
- A future `/airlines/{slug}` (M12-02) is cheap: public server-served pages are now a first-class
  shape with a precedent, rather than a carve-out in the SPA's login wall.
- The page is not yet the front door. `pnpm ops:status` and the deploy tell you what production
  serves; this ADR does not change it.

## Alternatives rejected

**A public route inside the SPA.** Forces `WEB_SURFACE=app` on production, gives crawlers an empty
root, spends LANDING-11's performance budget, and puts a hole in `RequireSession`'s whole-table wrap.
Rejected on all four.

**Replacing the holding page now.** Ships a sign-in button that cannot work on production, and makes
merging a milestone into a launch decision. Rejected — see decision 4.

**A static shell that hydrates.** The right eventual shape if the stats need live data on a
zero-session page, and this decision does not preclude it: the document is static, so hydration can
be added where it is needed rather than assumed everywhere. Deferred to LANDING-09, which will know
whether it needs it.
