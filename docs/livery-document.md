# Livery document format (M6-01)

Tailfin stores a livery as vector instructions, never as a source bitmap. The canonical
contract is the `LiveryDocument` Zod schema in `packages/shared/src/livery.ts`; the derived
`liveryDocumentJsonSchema` exists for non-Zod consumers. The future SVG builder and server
raster renderer must import one of those exports rather than restating the shape.

## Stored shape

Every document carries:

- `format: "tailfin-livery"` and numeric `formatVersion: 1`;
- a canonical uppercase hex brand `palette`;
- `layers` in paint order, back to front.

Every layer has a compact stable id, template `zone`, transform, style, opacity, blend mode
and optional mask. It also carries `visible` and `locked`, because those builder states must
survive autosave. The `type` discriminator selects one payload:

| Type        | Type-specific data                                                         |
| ----------- | -------------------------------------------------------------------------- |
| `fill`      | its common style's fill                                                    |
| `gradient`  | linear/radial geometry and ordered colour stops                            |
| `cheatline` | anchor, total width, angle, sweep, taper and proportional coloured stripes |
| `shape`     | rectangle, ellipse or polygon plus its boolean operation                   |
| `path`      | move, line, quadratic/cubic bezier and close commands                      |
| `text`      | text, font, sizing, tracking, alignment and optional arc                   |
| `logo`      | a reusable logo-composer asset id and mirror flag                          |
| `decal`     | a reusable decal-library asset id and mirror flag                          |

Coordinates are measured in zone units: `(0, 0)` is the zone origin and `(1, 1)` its full
extent. Geometry may extend outside that interval and is clipped by the target template.
That makes one document projection- and family-independent while preserving intentional
bleed. The ten zone ids come directly from design §5.1 and must also be used by both
side-profile and top-down SVG templates in M6-02.

Zone clipping is implicit. A layer can additionally mask through another zone or an earlier
layer. Earlier-only references make a mask graph acyclic without a second ordering field;
duplicate layer ids, forward mask references and unordered gradient stops are invalid.

## Size and versioning

`LiveryDocument` measures compact `JSON.stringify` output as UTF-8 and rejects a document at
or above 20 KiB. The representative test uses all eight layer types across 30 layers and
stays below that budget. Limits on palettes, paths, text and layer count also prevent an
editor action from creating an unbounded payload before the final byte check.

Authoritative persisted reads go through `migrateLiveryDocument` in `@tailfin/sim`, including
documents loaded for server rendering. It validates v1, refuses a newer version rather than
misrendering it, and walks a registry of consecutive `N → N+1` pure migrations for older
data. A new version therefore adds its new shared schema and one migration step; authoritative
callers do not branch on versions themselves. The web package cannot import sim by design;
M6-03 must resolve how browser-local autosave drafts are upgraded when it defines that storage
boundary, rather than duplicating this registry in the client.

## Ownership and application boundary

`Livery` is the saved brand envelope: livery id, owning airline id, name, variant and the
visual document. Variants are `standard`, `retro`, `special`, `cargo` and `alliance`, matching
design §5.4.

`LiveryApplicationTarget` expresses the same section's three scopes:

- `fleet` means every applicable airframe owned by the airline;
- `subfleet` is an explicit non-empty set of airframe ids;
- `airframe` names one airframe.

`LiveryApplication` pairs one of those targets with the livery id, ready for M6-07 to wrap in
its server-authoritative repaint command.

The explicit set avoids inventing a persistent `subfleet` entity before its mechanics exist.
M6-07 may resolve a family or a saved UI selection to that set, but ownership validation,
repaint cost, hangar downtime and writing `airframe.livery_id` belong to that milestone.

M6-01 adds no database table, API, SVG template, builder screen or raster pipeline. M6-02
through M6-06 supply those consumers; until M6-07 applies a saved livery, fleet thumbnail
URLs honestly remain null.
