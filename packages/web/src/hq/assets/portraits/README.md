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

| File                       | Role                                  | Supplied image                                                              |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `route-planner.webp`       | Route Planner (Mara Ellison)          | Woman in a blazer against a lit global route-network map                    |
| `route-planner-2.webp`     | Route Planner (Tom Bakker)            | Young man, TAILFIN lanyard, whiteboard of AMS route opportunities           |
| `route-planner-3.webp`     | Route Planner (Victor Lindqvist)      | Older man with grey hair, "TAILFIN SIM — Smarter routes" screen             |
| `revenue-manager.webp`     | Revenue Manager (Kenji Tan)           | Man at a revenue dashboard, "YIELD DEMAND PROFITABILITY" mug, RM books      |
| `revenue-manager-2.webp`   | Revenue Manager (Sofía Reyes)         | Woman at a "REVENUE OVERVIEW $148.7M" dashboard, MEX routes                 |
| `revenue-manager-3.webp`   | Revenue Manager (Anders Holm)         | Older grey-haired man, "REVENUE & DEMAND OVERVIEW" screen                   |
| `ops-controller.webp`      | Ops Controller (Diego Alvarez)        | Man with a headset in an ops control room, weather radar behind             |
| `ops-controller-2.webp`    | Ops Controller (Marta Silva)          | Woman with a headset in an ops room, weather radar behind                   |
| `ops-controller-3.webp`    | Ops Controller (Jun Park)             | Man with glasses at an "OPERATIONS OVERVIEW" dashboard                      |
| `chief-pilot.webp`         | Chief Pilot (Sten Halvorsen)          | Man in a four-bar pilot uniform with wings, in a cockpit                    |
| `chief-pilot-2.webp`       | Chief Pilot (Fiona Brennan)           | Red-haired woman in a four-bar captain uniform, "CHIEF PILOT" door placard  |
| `chief-pilot-3.webp`       | Chief Pilot (Grant Wexford)           | Older grey-haired man in captain uniform, "FLIGHT SAFETY LEADERSHIP" poster |
| `ground-ops.webp`          | Head of Ground Ops (Nadia Kovač)      | Woman in hi-vis, "HEAD OF GROUND OPS" badge, on the apron by a jet          |
| `ground-ops-2.webp`        | Head of Ground Ops (Omar Haddad)      | Bald man with glasses at a "GROUND OPERATIONS OVERVIEW" dashboard           |
| `ground-ops-3.webp`        | Head of Ground Ops (Luca Moretti)     | Young man in hi-vis, "GROUND OPS" badge, by a fuel truck and jet            |
| `safety-compliance.webp`   | Safety & Compliance (Claire Fontaine) | Woman in hi-vis, "SAFETY & COMPLIANCE" badge, in a maintenance hangar       |
| `safety-compliance-2.webp` | Safety & Compliance (Hiroshi Tanaka)  | Older man with glasses, arms folded, "SAFETY & COMPLIANCE" board            |
| `safety-compliance-3.webp` | Safety & Compliance (Emma Larsson)    | Blonde woman with a tablet, "SAFETY & COMPLIANCE" board in a hangar         |

## C-Suite portraits (§9.1 follow-up)

The executive floor's roster has its own twenty-four portraits, `csuite-01.webp`
… `csuite-24.webp`, one per candidate in `EXECUTIVE_CANDIDATES` (shared) and
imported by id in `csuite-roster.ts`. Ids 01–08 are the Directors, 09–16 the Vice
Presidents, 17–24 the Presidents; the id is the only link between a face, a name,
a role and a standing hire, so the filename must match the candidate id exactly.
Same shape and treatment as the head-office portraits — `600 x 800` webp, 3:4,
greyed until hired by the same CSS `filter`. To replace one, keep its `csuite-NN`
filename; nothing else changes. `csuite-placeholder.svg` is the fallback for any
id whose file is missing.

## More candidates per seat (§9.1 follow-up)

Each of the six seats now fields more than three candidates, so the market can show
a **rotating four per seat** that reshuffles daily. The extra faces continue the
seat's numbering — `route-planner-4.webp` … `-7.webp`, `revenue-manager-4/-5`,
`ops-controller-4…7`, `chief-pilot-4…7`, `ground-ops-4…7`, `safety-compliance-4…6`.
`hq-roster.ts` maps each file to a candidate id (surname-based, e.g.
`route-planner-rahman`), and the identity/tier/salary/boost for that id live in the
shared `OFFICE_CANDIDATES` catalogue. A new arrival is one raw entry there plus its
portrait here; a missing portrait is a build error.

## Format

- Portrait, roughly **3:4** — the card box is `aspect-ratio: 3/4` with `object-fit: cover`,
  so a squarer source is centre-cropped rather than letterboxed. No text is baked into the
  image (unlike the crew banners), so cropping is safe.
- Prefer **`.webp`** at quality ~82, as the crew banners are. If you keep `.svg`, update the
  import extensions in `hq-portraits.ts`; if you switch to `.webp`, update them there too.
- One file per role serves both states — hired vs unhired is a CSS `filter`
  (`.hq-card__portrait` in `shell/shell.css`), not a second asset.
