# The landing page's artwork

**Owner:** LANDING-03 · **Files:** `packages/web/landing/*.webp` · **Design language:** [landing-design-language.md](landing-design-language.md)

Two pieces of original art carry the public front door: a night-lights world map behind the
hero, and five aircraft side profiles in the fleet card. This is the record of what they are,
where they came from, and what still has to happen to them.

Held by `packages/web/src/theme/landing-artwork.test.ts`, which asserts format, dimensions,
absence of metadata, and that the directory and the document still agree about which files
exist. Byte budgets live in `packages/server/src/app.test.ts`, asserted on the served
response, because it is the transfer that costs a visitor something.

---

## The rule this artwork exists under

> **Text, metrics, airport codes and UI labels stay in HTML and SVG, never in pixels.**

Baked labels cannot be translated (M13-06), cannot be read aloud, and go soft on a display the
asset was not generated for. Baked route arcs and aircraft can never become live, which is the
entire point of LANDING-05. Baked UI cannot be corrected without regenerating and re-optimising
an image.

**The shipped hero breaks this rule, and that has been reviewed and accepted** (2026-09-08). It
is a known cost with a named consequence for LANDING-05, not a defect waiting to be found — see
below before changing anything about it.

---

## What ships today

| file                 | size        | bytes  | what it is                             |
| -------------------- | ----------- | ------ | -------------------------------------- |
| `landing-hero.webp`  | 2400 × 1351 | 227 kB | Night-lights world map behind the hero |
| `fleet-atr72.webp`   | 1400 × 467  | 19 kB  | ATR 72-600 side profile                |
| `fleet-e190.webp`    | 1400 × 467  | 17 kB  | E190-E2 side profile                   |
| `fleet-a321neo.webp` | 1400 × 467  | 17 kB  | A321neo side profile                   |
| `fleet-777.webp`     | 1400 × 467  | 17 kB  | 777-300ER side profile                 |
| `fleet-747.webp`     | 1400 × 467  | 21 kB  | 747-400 side profile                   |

All six are WebP, served from Tailfin's own origin under `img-src 'self'`. No CDN, no image
host, no CSP change. All six were checked for `EXIF`, `XMP` and `ICCP` chunks and carry none —
generation tools routinely embed prompts, model names and local file paths there, and a binary
file is where that survives review.

The five aircraft are one size on purpose. The carousel translates a flex track by exactly 100%
per slide, so a single aircraft at a different aspect ratio would change the slide height and
the section below would move on a five-second timer.

### Provenance

|                          |                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Supplied by              | @simmeh024, during the LANDING milestone                                                                                                       |
| Date                     | 2026-09-08                                                                                                                                     |
| Post-processing          | Downscaled and encoded to WebP for this repository. The hero came from a ~1.7 MB source; the aircraft from a supplied archive of five renders. |
| Sources                  | **Not in the repository**, and not pointed at from it — see below                                                                              |
| Generation tool          | **Not recorded**                                                                                                                               |
| Prompt                   | **Not recorded**                                                                                                                               |
| Licence / commercial use | **Not recorded**                                                                                                                               |

**Three of those are blank and that is a gap, not a formatting choice.** LANDING-03 asks for
tool, prompt, date and post-processing precisely because _an asset nobody can regenerate is an
asset that can never be corrected_ — and the hero already needs correcting. Whoever produced
these can fill the rows in; guessing at them would be worse than leaving them empty, because a
plausible wrong prompt is one somebody would later trust.

The licence row matters on its own and is a product question, not a technical one: TIDY-05
(#478) is settling Tailfin's licensing posture, and anything on the public front door inherits
it. What can be said from inspection is that no asset carries a watermark, generated text
beyond the map's own labels, or a recognisable real-airline livery — the aircraft wear
Tailfin's own tail mark and nothing else.

### Where the sources should live

Shipped files are optimised; sources are not in the repository. That is the right split — a
multi-megabyte master must never be served to a browser — but only half of it is done, because
nothing records **where the masters are**. A pointer belongs in this section: an object-store
path, a shared drive, anything a future maintainer can follow. Without it the practical
position is that the shipped WebP _is_ the master, which is the situation the split exists to
avoid.

---

## Accepted for now: the hero bakes what it must not bake

**Reviewed and accepted by @simmeh024 on 2026-09-08** — _"the hero image is fine as of now"_ —
after the audit below was put to them. So this is a **deferred constraint, not an oversight**,
and the distinction matters to exactly one person: whoever picks up LANDING-05 and finds a map
with a network already painted on it. They are drawing over it by decision.

Nothing here is a defect to be fixed on sight. It is the cost of the current asset, written
down so it is paid knowingly.

`landing-hero.webp` is not ground only. It has, in pixels:

- five airport codes — **AMS, FRA, JFK, NRT, MEX** — as rendered text;
- five node markers, four blue and one amber;
- three route arcs, two solid and one dashed;
- three aircraft glyphs along those arcs;
- a faint graticule.

Every one is on LANDING-03's explicit "no" list, and the consequences are the ones the rule
predicts rather than theoretical ones:

- **The codes cannot be translated or read aloud.** They are the only text on the page a screen
  reader cannot reach and M13-06 cannot externalise.
- **The arcs and aircraft can never move.** LANDING-05 — _"a world map that could one day be
  alive"_ — has to draw live routes from real flights. Over a map that already has three
  painted on it, the result is two networks: one real and one decorative, in slightly different
  blues.
- **They resample.** Text baked at 2400px is soft on a 3× phone and softer again in the narrow
  crop that does not exist yet.

**This is why the narrow crop was not produced.** LANDING-10 needs a purpose-made phone
composition and the obvious move is to crop the existing master — but every crop worth showing
contains labels, so cropping would duplicate the problem into a second asset rather than solve
it. The crop should be made from the regenerated ground.

### What fixes it, when somebody decides to

Regenerate the hero as **ground only** — geography, water, city lights, atmospheric glow,
negative space where the interface sits — in a desktop and a narrow crop. Then LANDING-05 puts
the nodes, arcs, codes and aircraft back as **SVG in the document**, where they are
translatable, announceable, sharp at any density, and able to be driven by real flights.

That needs an image generator this repository does not have, and it needs the provenance rows
above filled in so the new asset matches the old one's direction.

**Until then, LANDING-05 has a decision to make rather than a blocker.** Live routes drawn over
a map with three painted arcs give a visitor two networks in slightly different blues, so that
issue has to choose: regenerate the ground first, draw only in regions the baked arcs do not
touch, or accept the doubling. Naming the choice here is the point — it is much cheaper to make
before the live map is built than after.

Nothing else in the milestone is blocked. LANDING-04, -06, -07 and -09 all sit on top of this
image and do not care what is in it.

---

## Open: the aircraft are provisional

The five side profiles are a stand-in, marked as such in `index.html` at the carousel they
feed. **VIS-05 (#376)** is the reusable aircraft render layer and **VIS-15 (#386)** the
scene-generation API; between them they produce a real Tailfin aircraft rendered from an actual
livery document, which beats an illustration of one.

When they land, these files are deleted and the `<img>` tags point at rendered output. The
markup does not otherwise change, because each slide is already an image and a caption.

---

## Degradation

Every image can fail and the page still works: the ground is `--lp-bg` on both the body and the
hero — the hero paints its own so the letterboxed map never shows page black through it — the
headline, lede and pillar icons are text and inline SVG, and both sign-in buttons are ordinary
anchors. A broken aircraft image still says which aircraft it was, because the caption is
markup and the `alt` text is real.

`e2e/smoke/foundation.spec.ts` aborts every image request and asserts exactly that, rather than
hiding the elements — so the browser takes the same path it would on a real failure.
