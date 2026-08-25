# Livery document format v2 (M6-10)

Tailfin stores a livery as compact semantic artwork, never as a model or source bitmap. The
authoritative contract is the `LiveryDocument` Zod schema in
`packages/shared/src/livery.ts`; `liveryDocumentJsonSchema` is derived from that schema for
non-Zod consumers. Browser tools, persistence boundaries and render workers must consume this
one contract.

The architecture decision is recorded in
[`adr/0021-true-3d-livery-documents.md`](adr/0021-true-3d-livery-documents.md).

## Stored shape

Every v2 document carries:

- `format: "tailfin-livery"` and `formatVersion: 2`;
- an `artwork` declaration for Tailfin's normalized, model-independent `0..1` coordinate space;
- `renderMode`, either `uv3d` or the explicit `legacy_svg` compatibility path;
- exact `assetBindings` and optional `familyOverrides` for true-3D documents;
- a canonical uppercase hex brand `palette`;
- `layers` in deterministic paint order, back to front.

An asset binding is an opaque compatibility id plus four independently versioned resources:
the aircraft asset, livery UV set, material binding and named anchor/safe-area set. A true-3D
document must contain at least one complete binding. A legacy document must contain none. A
model, UV map or material manifest upgrade therefore creates a new compatibility tuple; it
cannot silently change a previously published livery.

The material-binding resource owns paintable and protected material semantics. Its intake
contract is documented in [`aircraft-3d-assets.md`](aircraft-3d-assets.md). The livery
document does not name cockpit glass, lights, tyres or aircraft families itself. Likewise,
anchors are stable ids resolved through the bound anchor-set resource rather than coordinates
hard-coded for an A320, ATR or any other family.

## Layers and placement

Every layer has a compact stable id, semantic zone, transform, style, opacity, blend mode,
optional mask and explicit placement. Placement selects `port`, `starboard` or `both`; a
both-side layer must `repeat` or `reflect`, while a single-side layer has no symmetry operation.
An optional named anchor locates details such as a tail logo or registration within the exact
bound anchor set.

The `type` discriminator selects one payload:

| Type           | Type-specific data                                                             |
| -------------- | ------------------------------------------------------------------------------ |
| `fill`         | the common style fill                                                          |
| `gradient`     | linear/radial geometry and ordered colour stops                                |
| `cheatline`    | anchor, width, angle, sweep, taper and proportional coloured stripes           |
| `shape`        | rectangle, ellipse or polygon plus a boolean operation                         |
| `path`         | move, line, quadratic/cubic bezier and close commands                          |
| `brush`        | bounded pressure points, width, hardness and spacing                           |
| `text`         | text plus an exact font version, sizing, tracking, alignment and optional arc  |
| `logo`         | an exact reusable logo resource version                                        |
| `decal`        | an exact reusable decal resource version                                       |
| `registration` | the server-resolved `airframe.registration` token plus exact font presentation |

Geometry is authored in the canonical artwork space and may extend beyond `0..1` for bleed.
The bound UV/anchor resources decide how logical artwork reaches a particular model. Family
overrides may only change a layer's visibility, transform or placement for one exact
compatibility id; they do not fork or replace the canonical artwork.

Zone clipping remains useful semantic information and keeps legacy SVG projection available.
An optional layer mask may reference a zone or an earlier layer. Earlier-only references make
the mask graph acyclic without a second ordering field. Duplicate layer ids, forward masks,
unordered gradient stops, duplicate bindings and dangling overrides are invalid.

## Deterministic identity and publication

`canonicalLiveryDocumentJson` recursively sorts object keys while preserving array paint order
and emits compact JSON. `serializedLiveryDocumentSize` measures those UTF-8 bytes. Parsed
documents contain finite numbers and canonical colors, so equal documents produce equal bytes
regardless of object insertion order. Documents at or above 20 KiB are rejected.

The canonical bytes are the SHA-256 input for a published livery's `contentSha256`. The shared
contract distinguishes:

- `LiveryDraft`: mutable, revisioned working state;
- `PublishedLiveryVersion`: immutable snapshot with a monotonic human-readable version and
  SHA-256 content identity.

The persistence issue enforces append-only publication. A non-visual rename may update draft
metadata without changing the document hash. Any visual change publishes a new snapshot;
existing generated assets remain bound to their original published version and hash.

## v1 migration and fallback

`LiveryDocumentV1` remains a readable schema. `migrateLiveryDocumentV1ToV2` losslessly adds the
canonical artwork declaration, deterministic placement and legacy resource versions, then
marks the result `legacy_svg`. It does not guess UV coordinates or invent an aircraft binding.

Authoritative reads call `migrateLiveryDocument` in `@tailfin/sim`, whose linear registry now
contains the `1 → 2` transform. Browser-local M6-03 drafts cannot import sim, so their existing
draft envelope/key recognizes a valid v1 payload and calls the same pure shared transform.
Corrupt or newer data still fails closed. Converting a legacy document to `uv3d` is a deliberate
future authoring action after compatible asset bindings exist, not an automatic migration.

## Boundary with VIS

M6 owns authored livery semantics, exact input bindings and publication identity. It does not
own rendered image entities, object storage or scene cache keys.

- VIS-02 (#373) records render assets and composed scenes, including resolved inputs and output
  metadata. It references the exact published livery; it does not restate this document.
- VIS-03 (#374) persists the monotonic published version and SHA-256 generated from the
  canonical bytes defined here. There is one livery version concept for M6 and VIS.
- VIS-10 (#381) owns the single render/scene cache-key function. Its inputs include the exact
  livery publication, aircraft/UV/material/anchor tuple, registration when generated text is
  present, camera, lighting, output size and manual renderer version.
- VIS-27 (#398) records why reusable render assets and scenes are cached and composited. The M6
  ADR narrows only the authoring-to-renderer boundary and does not supersede that decision.

GLB files, UV images, material manifests, anchor manifests, generated textures, renderer-private
objects and GPU state are all outside `LiveryDocument`.
