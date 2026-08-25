# Licensed 3D aircraft asset intake (M6-11)

Tailfin accepts a 3D aircraft only through the machine-readable `AircraftAssetManifest` in
`packages/shared/src/aircraft-asset.ts`. A visually convincing marketplace export is not enough:
the same contract covers geometry, livery UVs, materials, performance, provenance and rights.

This is an intake standard, not legal advice. The licence fields record project provenance and
the permissions Tailfin relies on. Ambiguous or missing rights block distribution until the
asset owner resolves them.

## Delivery and coordinate convention

Every delivery is one glTF 2.0 binary (`.glb`) plus external PBR texture files referenced by the
manifest. The source contract is:

- metres, right-handed `+Y` up and `-Z` forward;
- origin at the aircraft ground centre;
- object/node transforms baked before export;
- stable `tailfin-aircraft-v1` node and mesh names;
- an exact asset id/version, catalogue version, family and geometry-variant id;
- SHA-256 and byte size of the delivered GLB.

The manifest contains references and measurements, never embedded GLB or texture bytes. Replacing
the GLB, UVs, material mapping or anchors creates a new versioned resource. Published liveries
continue to reference the old four-part tuple described by
[ADR-0021](adr/0021-true-3d-livery-documents.md); there is no `latest` resolution in a publication.

## Livery UV and material contract

`TEXCOORD_1` is reserved for normalized livery artwork. Paintable islands must not overlap.
Deliberate port/starboard mirroring is permitted only when each mirrored island declares its id,
surface classes, source side and target side. At 4096 px the islands require at least 8 px of
padding.

Paintable classes are fuselage, fin, horizontal stabilisers, wings, winglets and nacelle
exteriors where the aircraft has them. Protected classes are cockpit glass, cabin windows,
exposed metal, rubber/tyres, lights, propellers and engine interiors. A manifest maps every GLB
material name to one class; the renderer does not infer protection from aircraft names or fuzzy
material-name matching.

Base colour and emissive textures use sRGB. Normal, metallic/roughness and occlusion textures are
linear. The required baseline is base colour (`RGBA`), normal (`XY`) and glTF metallic/roughness
(roughness in G, metallic in B); optional occlusion uses R and emissive uses RGB. PNG, JPEG and
KTX2 are accepted, up to 8192 px per dimension. Texture memory is measured after upload/decode,
not from compressed file size.

## Anchors, states, LOD and budgets

Every asset binds these named nodes: three framing cameras, centre of rotation, ground contact,
port/starboard registration and port/starboard tail-logo safe areas. Navigation, beacon and
landing-light sockets are optional but use the shared ids when present. Gear state is explicit.

LOD0, LOD1 and LOD2 are mandatory. LOD1 is no more than 50% of LOD0 triangles and LOD2 no more
than 20%. A fleet-render fallback is mandatory for legacy/non-GPU presentation. Intake ceilings
are:

| Profile    | LOD0 triangles | Draw calls | Materials | Texture memory | Maximum bounds W × L × H |
| ---------- | -------------: | ---------: | --------: | -------------: | -----------------------: |
| Regional   |        180,000 |         22 |        14 |        128 MiB |           40 × 45 × 15 m |
| Narrowbody |        260,000 |         28 |        18 |        192 MiB |           45 × 80 × 18 m |
| Widebody   |        420,000 |         36 |        24 |        256 MiB |          90 × 100 × 25 m |
| Very large |        560,000 |         44 |        28 |        384 MiB |         105 × 110 × 30 m |

These are refusal ceilings, not quality targets. An accepted file may still need optimisation
before production rollout, but optimisation never changes a published resource in place.

## Source assets versus VIS outputs

This manifest describes licensed source input. VIS-02 (#373) separately records generated
aircraft render assets and composed scenes: storage key, output hash, dimensions, renderer
version and the resolved inputs that produced them. It references the exact source-asset and
published-livery identities; it does not copy this intake schema or use the source GLB as a scene
record. Replacing an accepted source creates a new asset version and therefore a new VIS cache
identity under VIS-10 (#381). Existing render assets remain explainable by their old resolved
inputs.

## Licence and content evidence

The licence block records source type, creator/vendor, product URL and id, licence name, licence
text version/hash, acquisition date and the exact source-file hash. It separately records whether
commercial use, redistribution, derivative work and texture modification are permitted, plus
attribution and restrictions.

CI requires hashed evidence entries for proof of purchase, licence text and a vendor-terms
snapshot. The words “Pro licence” are not evidence and cannot make an asset distributable. The
licence source-file hash must equal the delivered GLB hash, so evidence for one download cannot
silently authorize another.

The content audit requires a neutral base coat and explicitly records whether a real-world airline
livery, trademarked logo or unlicensed logo remains. Any such content produces
`distribution_blocked`; designation/manufacturer text in catalogue data does not grant permission
to redistribute their marks or trade dress.

## CI intake outcomes

`evaluateAircraftAssetSubmission` is the single decision boundary:

| Status                     | Meaning                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `invalid_model`            | Delivery, geometry, UV, PBR, naming, material, anchor, LOD, budget or catalogue binding is invalid.             |
| `missing_licence_evidence` | Technical asset is valid, but required provenance is absent, incomplete or covers a different file hash.        |
| `distribution_blocked`     | Evidence is complete but permissions or the content audit prohibit distribution.                                |
| `accepted`                 | The technical contract, exact catalogue binding, pilot requirements, evidence and distribution rights all pass. |

The test fixtures exercise all four outcomes, including an invalid-axis model, incomplete
“Pro licence,” denied redistribution and embedded airline/trademark content.

## Catalogue-derived coverage matrix

`AIRCRAFT_ASSET_COVERAGE_V1` iterates `AIRCRAFT_CATALOGUE_V1.types` in canonical order. Authored
metadata supplies only the geometry relationship, resource id, budget profile and pilot link.
Construction fails on a missing or extra designation, a cross-family base, reuse with a changed
geometry id, or a geometry variant that failed to change its id.

`family_reuse` means one exterior geometry can serve both catalogue rows. `geometry_variant`
means a shared crew family is not enough: length, doors or another exterior feature requires a
separate model identity.

| Catalogue designation | Crew family | Geometry id   | Relationship     | Based on   | Budget     | Pilot         |
| --------------------- | ----------- | ------------- | ---------------- | ---------- | ---------- | ------------- |
| ATR 72-600            | ATR 72      | `atr-72-600`  | baseline         | —          | regional   | ATR pilot     |
| Dash 8-400            | Dash 8      | `dash-8-400`  | baseline         | —          | regional   | —             |
| E190-E2               | E-Jet E2    | `e190-e2`     | baseline         | —          | regional   | —             |
| A220-300              | A220        | `a220-300`    | baseline         | —          | narrowbody | —             |
| 737-800               | 737NG       | `737-800`     | baseline         | —          | narrowbody | —             |
| 737 MAX 8             | 737 MAX     | `737-max-8`   | baseline         | —          | narrowbody | —             |
| A320neo               | A320neo     | `a320neo`     | baseline         | —          | narrowbody | A320neo pilot |
| A321neo               | A320neo     | `a321neo`     | geometry variant | A320neo    | narrowbody | —             |
| A321XLR               | A320neo     | `a321neo`     | family reuse     | A321neo    | narrowbody | —             |
| 787-9                 | 787         | `787-9`       | baseline         | —          | widebody   | 787 pilot     |
| A350-900              | A350        | `a350-900`    | baseline         | —          | widebody   | —             |
| A350-1000             | A350        | `a350-1000`   | geometry variant | A350-900   | widebody   | —             |
| 777-300ER             | 777         | `777-300er`   | baseline         | —          | widebody   | —             |
| 777-9                 | 777X        | `777-9`       | baseline         | —          | widebody   | —             |
| A380-800              | A380        | `a380-800`    | baseline         | —          | very large | —             |
| 777F                  | 777         | `777f`        | geometry variant | 777-300ER  | widebody   | —             |
| 747-8F                | 747         | `747-8f`      | baseline         | —          | very large | —             |
| ATR 72-600F           | ATR 72      | `atr-72-600f` | geometry variant | ATR 72-600 | regional   | —             |

## Pilot assets

The pilots deliberately cover three different technical risks:

- **ATR 72-600:** high wing, six-blade protected propellers, gear pods, T-tail and turboprop
  material separation;
- **A320neo:** common narrowbody doors, sharklet UV continuity, underwing turbofans and separately
  paintable nacelle exteriors;
- **787-9:** widebody framing/budgets, raked wingtips, neutral wing flex and protected chevron
  engine interiors.

An asset naming one of these designations is technically invalid until its required feature tags
and paintable/protected material classes are present. This makes “pilot complete” a CI property,
not a note in a marketplace spreadsheet.
