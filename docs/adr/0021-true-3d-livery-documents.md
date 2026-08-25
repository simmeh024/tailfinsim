# ADR-0021: Model-independent livery documents with exact 3D asset bindings

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** @simmeh024
- **Constrains:** M6 true-3D livery work (#716), VIS livery inputs, and every future livery asset manifest

## Context

M6-01 deliberately stored layered vector instructions rather than bitmaps. Its SVG family
templates made those instructions editable and compact, but they are not enough for painting a
real model: a renderer must know the exact aircraft model, livery UV layout, material-to-zone
mapping and named safe areas. If those are resolved from whichever asset happens to be current,
an asset update can silently redraw a saved or published livery.

The true-3D work also meets the existing VIS architecture:

- VIS-02 (#373) models generated aircraft render assets and composed scenes;
- VIS-03 (#374) requires one immutable livery version and deterministic content hash;
- VIS-10 (#381) owns one complete cache identity for generated output;
- VIS-27 (#398) records the wider decision to cache reusable render assets and composed scenes.

M6 must supply an exact, renderable input without creating another output-asset entity, version
concept, cache function or storage model. Existing browser-local v1 drafts must remain readable,
but inventing UV placement during migration would create visual meaning that was never authored.

## Decision

### 1. The document stores semantic artwork, not render assets

`LiveryDocument` v2 is the one shared Zod contract used by browser tools, persistence boundaries
and output workers. It contains canonical normalized artwork, deterministic layer order and
versioned references. It never contains GLB bytes, texture pixels, UV images, renderer objects,
GPU buffers or generated output URLs.

Artwork uses the versioned `tailfin-aircraft-artwork` coordinate space, independent of a model.
Layers retain semantic zones and add port/starboard placement, symmetry and an optional named
anchor. Fills, gradients, vector paths, brush strokes, versioned logos/decals/fonts, text and a
generated registration token remain authoring instructions until a renderer resolves them.

### 2. True-3D compatibility is an exact resource tuple

Every `uv3d` document binds one or more opaque compatibility ids to exact versions of:

1. the aircraft asset;
2. its livery UV set;
3. its material-binding manifest;
4. its named anchor/safe-area set.

Changing any member creates a different tuple. A published document continues to name the old
tuple; no `latest` lookup exists in its render path. Family overrides target a compatibility id
and may adjust only layer visibility, transform or placement. They do not duplicate artwork or
contain aircraft-name conditionals.

The material-binding manifest classifies paintable materials and protected materials such as
glass, lamps, tyres and engine interiors. Those classifications belong to the versioned asset
manifest, not to hard-coded names in the document or renderer. The intake contract and
catalogue-derived coverage matrix are documented in
[`aircraft-3d-assets.md`](../aircraft-3d-assets.md) and implemented by M6-11 (#718).

### 3. Canonical bytes define livery content identity

`canonicalLiveryDocumentJson` recursively sorts object keys and preserves array paint order.
The UTF-8 result is the SHA-256 input for the published livery's `contentSha256`. A publication
has both that identity and a monotonic `publishedVersion`: the hash is authoritative for visual
content; the integer is readable in operations and player history.

Drafts are mutable revisioned work. Published versions are immutable snapshots. A visual edit
creates a new publication; a metadata-only rename does not. Persistence and append-only
enforcement belong to the M6 persistence work and VIS-03, but both consume the shared draft and
publication schemas defined here.

### 4. v1 is migrated into an explicit compatibility renderer

Version 1 remains a readable schema. The pure `1 → 2` migration preserves every layer, order,
style and resource id, adds deterministic both-side placement, and sets `renderMode` to
`legacy_svg`. It deliberately creates no 3D asset binding. Authoritative reads use the linear
sim migration registry; the browser draft boundary calls the same pure shared transform because
web cannot import sim.

Moving a legacy document to `uv3d` is a later, explicit authoring action against available
bindings. The SVG projector remains available for legacy documents and non-GPU fallback. It is
not expected to have exact visual parity with the true-3D path.

### 5. M6 provides inputs; VIS owns generated outputs

This decision narrows the seam rather than replacing VIS:

- M6 owns the authored document, exact input tuple, canonical bytes and published livery identity.
- VIS-02 owns database metadata for generated aircraft render assets and composed scenes, while
  object storage owns their bytes.
- VIS-03 persists the same published version/hash; it does not add a parallel livery version.
- VIS-10 owns the only render/scene cache-key function. It includes the exact livery publication,
  aircraft/UV/material/anchor tuple, resolved registration when the generated token is used,
  camera, lighting, environment, output dimensions and manual renderer version.
- VIS-27 owns the broader reusable-asset/composited-scene caching decision and is not superseded.

## Consequences

### What this makes easier

- A model or UV upgrade cannot silently rewrite an immutable published livery.
- One authored design can target several compatible families with small, explicit overrides.
- Protected physical materials remain protected through data, without per-aircraft renderer code.
- Equal semantic documents have equal canonical bytes, giving VIS one reliable livery identity.
- Old drafts continue to open honestly instead of being discarded or falsely promoted to 3D.

### What this makes harder

- **Asset coupling:** a publication is tied to exact model, UV, material and anchor resources.
  Retired versions must remain retrievable while referenced, or undergo an explicit reviewed
  migration that creates a new publication.
- **More migrations:** document schemas and asset manifests now have independent version
  histories. Compatibility has to be tested across both.
- **GPU dependency:** interactive true-3D preview needs a capable browser GPU API, and high-quality
  deterministic output needs GPU-capable worker infrastructure or a slower software path.
- **Two render paths:** the SVG fallback must remain safe and tested while legacy publications
  exist. It consumes maintenance and will not match PBR lighting exactly.
- **Generated text expands identity:** a registration layer means the resolved airframe
  registration participates in generated-asset identity even though the document stores a token.

### What we accept

We accept storage and maintenance for old asset versions, explicit migrations, a GPU deployment
dependency, and a retained fallback renderer. These costs buy reproducible player work. A cheaper
system that resolves today's model at render time is not acceptable because it rewrites history.

## Alternatives considered

| Option                                           | Why not                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Keep SVG templates as the primary renderer       | They cannot describe UV seams, material protection or true model topology, and the preview remains illustrative. |
| Store baked textures in each livery              | They are large, model-specific, difficult to edit and duplicate derived output inside the authoring document.    |
| Resolve the latest model and UV at render time   | Asset updates silently change published liveries and invalidate VIS/POD reproducibility.                         |
| Embed GLB/material/UV payloads in the document   | It destroys the compact contract, duplicates assets and makes every edit/upload a security and storage boundary. |
| Automatically convert v1 SVG zones to UV artwork | There is no lossless mapping; guessed placement would claim fidelity the old document never contained.           |
| Create an M6-specific render cache               | VIS already owns generated assets and deterministic cache identity; a second cache would eventually disagree.    |

## Revisit when

- No legacy publications or drafts remain for a measured retention period, making removal of the
  SVG renderer a real simplification rather than a data-loss event.
- GPU output cost or availability misses the operating budget established by the render-worker
  milestone, at which point server rendering or preview fidelity must be redesigned.
- Keeping referenced asset versions costs more than regenerating/migrating them under an approved
  retention policy.
- A new model format can carry a stable, vendor-independent livery coordinate/anchor standard;
  that may remove part of Tailfin's manifest layer, but must not weaken immutable bindings.

## References

- [M6-10 #717](https://github.com/simmeh024/tailfinsim/issues/717) — the issue this answers
- [M6 true-3D epic #716](https://github.com/simmeh024/tailfinsim/issues/716)
- [VIS-02 #373](https://github.com/simmeh024/tailfinsim/issues/373) · [VIS-03 #374](https://github.com/simmeh024/tailfinsim/issues/374) · [VIS-10 #381](https://github.com/simmeh024/tailfinsim/issues/381) · [VIS-27 #398](https://github.com/simmeh024/tailfinsim/issues/398)
- [`docs/livery-document.md`](../livery-document.md) — the implementation contract
