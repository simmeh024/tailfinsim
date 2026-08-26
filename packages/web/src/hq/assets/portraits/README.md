# Head Office portraits (M5-04)

One portrait per candidate in the §9.1 office market — the finished
head-and-shoulders images, `600 x 800` webp (the card's 3:4), cropped from the
supplied art with the face kept high in frame. A seat can have several
candidates; the Route Planner has three. `hq-roster.ts` imports each by
filename, so a missing one is a build error, and the greyed/colour treatment for
hired vs unhired is a CSS `filter` (`.hq-card__portrait` in `shell/shell.css`),
not a second asset.

To replace one, keep the filename and the 3:4 shape; nothing else changes.

## Which supplied image goes where

Each file is the finished portrait for the candidate named:

| File                     | Role                                  | Supplied image                                                         |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `route-planner.webp`     | Route Planner (Mara Ellison)          | Woman in a blazer against a lit global route-network map               |
| `route-planner-2.webp`   | Route Planner (Tom Bakker)            | Young man, TAILFIN lanyard, whiteboard of AMS route opportunities      |
| `route-planner-3.webp`   | Route Planner (Victor Lindqvist)      | Older man with grey hair, "TAILFIN SIM — Smarter routes" screen        |
| `revenue-manager.webp`   | Revenue Manager (Kenji Tan)           | Man at a revenue dashboard, "YIELD DEMAND PROFITABILITY" mug, RM books |
| `revenue-manager-2.webp` | Revenue Manager (Sofía Reyes)         | Woman at a "REVENUE OVERVIEW $148.7M" dashboard, MEX routes            |
| `revenue-manager-3.webp` | Revenue Manager (Anders Holm)         | Older grey-haired man, "REVENUE & DEMAND OVERVIEW" screen              |
| `ops-controller.webp`    | Ops Controller (Diego Alvarez)        | Man with a headset in an ops control room, weather radar behind        |
| `ops-controller-2.webp`  | Ops Controller (Marta Silva)          | Woman with a headset in an ops room, weather radar behind              |
| `ops-controller-3.webp`  | Ops Controller (Jun Park)             | Man with glasses at an "OPERATIONS OVERVIEW" dashboard                 |
| `chief-pilot.webp`       | Chief Pilot (Sten Halvorsen)          | Man in a four-bar pilot uniform with wings, in a cockpit               |
| `ground-ops.webp`        | Head of Ground Ops (Nadia Kovač)      | Woman in hi-vis, "HEAD OF GROUND OPS" badge, on the apron by a jet     |
| `safety-compliance.webp` | Safety & Compliance (Claire Fontaine) | Woman in hi-vis, "SAFETY & COMPLIANCE" badge, in a maintenance hangar  |

## Format

- Portrait, roughly **3:4** — the card box is `aspect-ratio: 3/4` with `object-fit: cover`,
  so a squarer source is centre-cropped rather than letterboxed. No text is baked into the
  image (unlike the crew banners), so cropping is safe.
- Prefer **`.webp`** at quality ~82, as the crew banners are. If you keep `.svg`, update the
  import extensions in `hq-portraits.ts`; if you switch to `.webp`, update them there too.
- One file per role serves both states — hired vs unhired is a CSS `filter`
  (`.hq-card__portrait` in `shell/shell.css`), not a second asset.
