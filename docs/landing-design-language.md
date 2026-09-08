# The landing page's design language

**Owner:** LANDING-02 · **Surface:** `packages/web/landing` · **Decision:** [ADR-0028](adr/0028-public-landing-surface.md)

This is the catalogue LANDING-04 … LANDING-09 compose from. Its job is that six sections
written by six different hands do not resolve the same six questions six different ways.

Everything here is enforced by `packages/web/src/theme/landing-tokens.test.ts`, which fails the
build on each rule below. If a statement in this document and that test disagree, the test is
right and this document is stale — say so rather than working around it.

---

## The surface, in one paragraph

The landing page is a **static document served off disk**, outside the Vite client. It cannot
import `theme/tokens.css`, cannot use a React component, and has no build step. Its stylesheet
and its one script are same-origin files because the CSP is `style-src 'self'` /
`script-src 'self'` with no hash for this page — see ADR-0028 decision 5 for the deploy that
shipped unstyled before that was understood.

It has **one theme, and it is dark.** The client has two. The hero is a photograph of a night
world and the whole composition is built on it; there is no light treatment of that image that
is not a different page.

---

## Tokens

All of them live in the `:root { … }` block at the top of `landing.css`, which is **the only
place in `packages/web/landing` allowed to contain a colour** — the HTML and the script
included. The first draft painted the tail fin with `fill="#ffb84d"` in markup, which no
stylesheet-only guard would ever have seen.

### What is shared with the client, and what is not

Ten values are pinned by test to `tokens.css`'s dark theme:

| landing                              | client                                | why it is shared                                      |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| `--lp-bg`                            | `--bg-base`                           | the ground a visitor sees before and after signing in |
| `--lp-surface`                       | `--bg-raised`                         | cards                                                 |
| `--lp-border` / `--lp-border-strong` | `--border-subtle` / `--border-strong` | hairlines                                             |
| `--lp-text` / `--lp-text-secondary`  | `--text-primary` / `--text-secondary` | ink                                                   |
| `--lp-ink-on-accent`                 | `--text-on-accent`                    | the CTA label                                         |
| `--lp-accent` / `--lp-accent-hover`  | `--accent` / `--accent-hover`         | interaction                                           |
| `--lp-brand`                         | `--brand`                             | the mark                                              |

Everything else — the display scale, the hero wash, the provider colours — is this surface's
alone, and pinning it to a client with no equivalent would be pinning it to nothing.

The duplication is deliberate and the test is the reason it is safe. A second copy of a shared
identity with nothing holding it in place is a fork with a delay on it.

### The two navies, reconciled

There were two: the client's `#0b1017` and the holding page's `#060a12`, which this page had
copied. Three points apart, indistinguishable side by side — which is how you can tell the
difference was never a decision.

**The landing page now uses the client's**, so the front door and the product share a ground.
**The holding page keeps `#060a12`**, because its `<style>` is inline and pinned in the
Caddyfile by hash, so editing it is an edge rollout rather than a deploy — and ADR-0028 retires
that document at go-live anyway. Two navies remain; one of them has an expiry date.

`<meta name="theme-color">` cannot hold a custom property, so it is the one colour outside the
token block. It is asserted equal to `--lp-bg`: unchecked, it drifts, and the symptom is a phone
painting its address bar a different navy from the page beneath it.

### The orange question, settled

`tokens.css` says the brand amber is **"brand mark only — never interaction, never status"**, and
the approved mock uses orange for the tail fin, the four feature icons and the full stop after
**MAKE IT YOURS.** None of those is interaction and none is status.

**The rule is about interaction and status, not about the hue.** The qualification is recorded in
`tokens.css` beside the prohibition, so the next reader finds both in one place. The test is one
question — _would a reader take this colour as an instruction, or as a state?_

- An amber button is out: it competes with the accent, and the single-accent guarantee is what
  makes blue mean "this does something".
- An amber figure in a statistics panel is out: a number that changes colour is a status.
- An amber tail fin is in. So is an icon beside a feature name, and a full stop.

`landing-tokens.test.ts` fails the build if a rule paints an interactive selector with
`--lp-brand`. Blue stays the only interactive colour on the page.

### Type

The **text steps are the client's own**, so the front door and the product set type at the same
sizes. Two additions, each with a job: `--lp-text-md` for the lede, and `--lp-text-provider` for
the sign-in buttons.

The **display steps are this page's alone** and are deliberately not in `tokens.css`: nothing in
the client sets 4.4rem type, and a scale sitting there unused is how `--rail-width-collapsed`
came to be defined-and-unused. Font weights and line heights are here for the same reason. When
UX-11 wants them for the client, this set is the shape to copy.

| token            | value                           | used for                   |
| ---------------- | ------------------------------- | -------------------------- |
| `--lp-display-1` | `clamp(2.4rem, 6.4vw, 4.4rem)`  | the headline               |
| `--lp-display-2` | `clamp(1.5rem, 3vw, 2.1rem)`    | section titles             |
| `--lp-display-3` | `clamp(1.25rem, 2.4vw, 1.7rem)` | the persistent-world aside |
| `--lp-display-4` | `clamp(1.3rem, 2.6vw, 1.75rem)` | stat figures               |
| `--lp-lede-size` | `clamp(1rem, 1.4vw, 1.0625rem)` | the lede                   |

Every display step is a `clamp()` rather than a media-query staircase, so type reflows
continuously. The `rem` floor is load-bearing: it scales with the reader's own text size, where a
`vw`-only rule would not, and a display headline overflowing at 200% text is the failure
LANDING-10 tests for.

### Space, radius, motion

`--lp-space-1` … `--lp-space-10` on a quarter-rem rhythm. The first draft of this page used
twenty-one distinct gap values, most within a hair of each other; a later section can now match
the rhythm instead of guessing at it.

Motion is `--lp-motion-fast`, `--lp-motion-slide` and two easings, **zeroed once at the root**
under `prefers-reduced-motion`. No component may restate the preference, and the test enforces
both halves: exactly one reduced-motion block, whose only selectors are `:root` and `html`, and
no duration typed into any rule. That is what keeps the rule true as sections are added by people
who did not read this file.

`scroll-behavior` is in that same root block, because it is the one motion on the page that is
not a duration and therefore cannot be a token.

### Breakpoints

Four bands, three boundaries: **mobile → tablet (48rem) → laptop (64rem) → wide desktop (90rem)**.
The client has one breakpoint; LANDING-10 needs four bands, and the laptop one matters most —
a two-column hero with a bleeding map has an awkward middle, which is also the app's own known
gap (UX-09).

**A media query cannot read a custom property.** `@media (min-width: var(--lp-bp-laptop))` is
invalid CSS and fails _silently_: the query never matches and the layout it guards simply never
arrives. So the literal stays in the query and the test asserts every media width equals a
declared `--lp-bp-*` token. Everything is written mobile-first, `min-width` only, so no boundary
needs an off-by-one companion (`max-width: 47.99rem`) that a token could not express either.

---

## Contrast

Measured, not asserted, and re-measured by the test on every run so the numbers cannot rot.
LANDING-10 owns holding the _page_ to AA; these are the palette's figures.

| pair                                    | ratio    | bar | note                            |
| --------------------------------------- | -------- | --- | ------------------------------- |
| `--lp-text` on `--lp-bg`                | 16.38    | 4.5 |                                 |
| `--lp-text` on `--lp-surface`           | 15.01    | 4.5 |                                 |
| `--lp-text` on the hero wash            | 14.79    | 4.5 |                                 |
| `--lp-text-secondary` on `--lp-bg`      | 8.19     | 4.5 |                                 |
| `--lp-text-secondary` on `--lp-surface` | 7.51     | 4.5 |                                 |
| `--lp-text-secondary` on the hero wash  | 7.40     | 4.5 |                                 |
| `--lp-accent` on `--lp-bg`              | 8.88     | 4.5 | link text                       |
| `--lp-ink-on-accent` on `--lp-accent`   | 8.80     | 4.5 | the CTA                         |
| `--lp-brand` on `--lp-bg`               | 11.10    | 3.0 | a graphic, not text             |
| `--lp-brand` on the hero wash           | 10.02    | 3.0 |                                 |
| white on `--lp-google`                  | **3.56** | 3.0 | **large text only** — see below |
| white on `--lp-discord`                 | 4.61     | 3.0 | passes at any size              |

Two findings worth keeping.

**There is no third, quieter ink.** `tokens.css`'s `--text-muted` (#6d7c93) was the obvious
import and measures **4.13:1 on `--lp-surface`** — under AA, on the cards, for copy — and exactly
4.50 on the page ground, which is the kind of pass that becomes a fail the first time a surface
moves. It reads as "the quiet one" and would have ended up on every caption. The quiet register
here is **size and weight, not a dimmer colour**, and the test names the value so re-adding it
has to be deliberate.

**Google's published sign-in button is not AA at body size.** White on `#4285F4` is 3.56:1, and
Google's branding guidelines specify that exact pairing — so honouring the guideline and
honouring AA are in direct conflict. WCAG's large-text threshold is 3:1 at ≥18.66px bold, so
`--lp-text-provider` is `1.1875rem` (19px) at weight 700 and the pair **conforms as large text**
rather than by waiver. Discord gets the same treatment so the two buttons match. The size is not
styling: shrink it and the ratio does not change but its threshold does, from 3 to 4.5, and the
button silently stops being accessible. The test pins the size, the weight and the rule together.

---

## Components

Every class is `lp-`. The client's families are unreachable from here and must not be recreated
here either — a landing page borrowing `.login__button` would be the mistake UX-11 exists to fix,
in a new place.

The prefix is not only hygiene. `.card`, `.panel` and `.stat` — this page's names before
LANDING-02 — are all live in `dashboard.css`, so the moment ADR-0028's deferred _"static shell
that hydrates"_ arrives, an unprefixed family collides with the product on its first day. A
collision between a marketing card and a finance card is not a bug anyone would think to look for
here.

| class                                                                               | what it is                                                                    | owner                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------- |
| `.lp-wrap`                                                                          | the page gutter and max width                                                 | LANDING-02                  |
| `.lp-skip` · `.lp-sr-only`                                                          | keyboard and screen-reader helpers                                            | LANDING-02, extended by -10 |
| `.lp-header` · `__inner` · `__nav`                                                  | the top bar                                                                   | LANDING-02                  |
| `.lp-brand` · `__mark`                                                              | the wordmark and tail fin                                                     | LANDING-02                  |
| `.lp-cta`                                                                           | the nav's blue call to action                                                 | LANDING-13                  |
| `.lp-hero` · `__grid` · `__copy`                                                    | the first screen and its map layers                                           | LANDING-04, -05             |
| `.lp-headline` · `__stop`                                                           | the display headline                                                          | LANDING-04                  |
| `.lp-lede`                                                                          | the supporting paragraph                                                      | LANDING-04                  |
| `.lp-pillars` · `__item` · `__icon`                                                 | the four feature shorthands                                                   | LANDING-04                  |
| `.lp-signin` · `__title` · `__buttons` · `__note`                                   | the sign-in card                                                              | LANDING-13                  |
| `.lp-provider` · `--google` · `--discord` · `__mark`                                | one button per provider                                                       | LANDING-13                  |
| `.lp-section` · `__title`                                                           | a page section                                                                | all                         |
| `.lp-split` · `.lp-cards`                                                           | the two page layouts                                                          | LANDING-06, -07             |
| `.lp-card` · `__title` · `__body`                                                   | a feature card                                                                | LANDING-06                  |
| `.lp-figure`                                                                        | a placeholder frame inside a card                                             | LANDING-06, -07             |
| `.lp-fleet` · `__viewport` · `__track` · `__slide` · `__image` · `__type` · `__nav` | the aircraft carousel                                                         | LANDING-06                  |
| `.lp-aside` · `__title` · `__body`                                                  | the persistent-world panel                                                    | LANDING-07                  |
| `.lp-stats` · `.lp-stat` · `__value` · `__value--pending` · `__label`               | the world-status strip                                                        | LANDING-09                  |
| `.lp-footer` · `__line` · `__mark` · `__sub`                                        | the footer                                                                    | LANDING-02                  |
| `.lp-todo`                                                                          | scaffolding, and every one names the issue that owes this page something real | deleted as they land        |

**Compose from these.** If a section genuinely needs a new component, add it here with its owner
in the same change — the catalogue is the thing that keeps six sections looking like one page.

## What this issue did not decide

- **Layout at each of the four bands.** LANDING-02 supplies the boundaries; LANDING-10 designs the
  mobile composition, the section order and the narrow map crop.
- **AA conformance for the page.** These are the palette's figures. Touch targets, 200% text,
  focus order and the accessibility tree are LANDING-10.
- **Imagery.** LANDING-03.
- **The words.** LANDING-04 onward.
