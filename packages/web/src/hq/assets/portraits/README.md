# Head Office portraits (M5-04)

One portrait per candidate in the §9.1 office market. A seat can have several candidates — the Route Planner has three. The committed `*.svg` files are **placeholders**
so the build is green and the Headquarters page is real before the artwork lands.
Replace each with the finished head-and-shoulders portrait, keeping the filename —
`hq-roster.ts` imports it, so nothing else changes.

## Which supplied image goes where

The six portraits supplied with the M5-04 brief map to the roles by what they show:

| File                              | Role                                  | Supplied image                                                         |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `route-planner.svg` → `.webp`     | Route Planner (Mara Ellison)          | Woman in a blazer against a lit global route-network map               |
| `route-planner-2.svg` → `.webp`   | Route Planner (Tom Bakker)            | Young man, TAILFIN lanyard, whiteboard of AMS route opportunities      |
| `route-planner-3.svg` → `.webp`   | Route Planner (Victor Lindqvist)      | Older man with grey hair, "TAILFIN SIM — Smarter routes" screen        |
| `revenue-manager.svg` → `.webp`   | Revenue Manager (Kenji Tan)           | Man at a revenue dashboard, "YIELD DEMAND PROFITABILITY" mug, RM books |
| `ops-controller.svg` → `.webp`    | Ops Controller (Diego Alvarez)        | Man with a headset in an ops control room, weather radar behind        |
| `chief-pilot.svg` → `.webp`       | Chief Pilot (Sten Halvorsen)          | Man in a four-bar pilot uniform with wings, in a cockpit               |
| `ground-ops.svg` → `.webp`        | Head of Ground Ops (Nadia Kovač)      | Woman in hi-vis, "HEAD OF GROUND OPS" badge, on the apron by a jet     |
| `safety-compliance.svg` → `.webp` | Safety & Compliance (Claire Fontaine) | Woman in hi-vis, "SAFETY & COMPLIANCE" badge, in a maintenance hangar  |

## Format

- Portrait, roughly **3:4** — the card box is `aspect-ratio: 3/4` with `object-fit: cover`,
  so a squarer source is centre-cropped rather than letterboxed. No text is baked into the
  image (unlike the crew banners), so cropping is safe.
- Prefer **`.webp`** at quality ~82, as the crew banners are. If you keep `.svg`, update the
  import extensions in `hq-portraits.ts`; if you switch to `.webp`, update them there too.
- One file per role serves both states — hired vs unhired is a CSS `filter`
  (`.hq-card__portrait` in `shell/shell.css`), not a second asset.
