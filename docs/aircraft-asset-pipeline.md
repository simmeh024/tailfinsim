# Deterministic aircraft asset pipeline (M6-12)

The aircraft asset pipeline turns an accepted M6-11 source manifest and its immutable GLB into a
reviewed runtime GLB. It is a build tool, not a renderer or upload service. Runtime bytes live under
`assets/aircraft/runtime/` when they are committed; VIS-13 will decide how those generated paths map
to object-storage keys and VIS-14 will decide how immutable URLs are delivered.

The committed registry is currently empty because no licensed aircraft source has been admitted.
That is an explicit state, not a placeholder asset. A marketplace preview, a fleet-render image or
the name of a licence is never treated as source evidence.

## Inputs and command

AI-generated candidates start with the separate [aircraft factory preflight](aircraft-factory.md).
That command is offline and cannot admit an asset or spend credits. Generation/provenance and
canonical preparation must pass their review gates before entering the intake below.

An intake has two authored inputs beside the source files:

- the `AircraftAssetManifest` from `packages/shared/src/aircraft-asset.ts`, including exact source
  hash, model/UV/material/anchor versions and licence evidence;
- a `tailfin-aircraft-optimisation-decision`, recording the renderer compatibility version,
  compression choices, measurements, intentional animation/camera/light/metadata allowances and
  any budget exception.

Run it from the repository root:

```bash
pnpm assets:intake -- \
  --manifest path/to/manifest.json \
  --decision path/to/optimisation.json \
  --root assets/aircraft
```

The tool never enables network reads. A source GLB may refer only to safe relative texture files
declared by the manifest. Runtime output embeds every dependency; an external runtime URI is a hard
failure.

### Hi3D A320neo salvage candidate

The supplied Hi3D A320neo is a valid but monolithic reconstruction: one unnamed mesh, one primitive
and one material. Its 100 connected components are capture chunks rather than aircraft parts, so a
generic “split by loose parts” operation still produces no useful fuselage/wing/engine contract.

`assets:salvage:a320neo` is a deterministic, asset-specific preparation step before intake. It
samples the original base-colour atlas and classifies triangles with normalized A320neo spatial
rules, then emits named paintable/protected materials, three LODs, `TEXCOORD_1`, identity transforms,
metre-scale bounds, the complete anchor/light-socket set, 4096-pixel PBR inputs and a z-buffered
three-view semantic audit image. It also runs Khronos' validator and refuses to emit a candidate
with any error or warning.

```bash
pnpm assets:salvage:a320neo -- \
  --input path/to/A320neo.glb \
  --output assets/aircraft/candidates/a320neo/1.0.0 \
  --date YYYY-MM-DD
```

The current pinned input is SHA-256
`4421977f9f3ee6539f50d8ba20fd0a5f371d70cfffc946b58d639887cb676cd2`. The command writes
`manifest.draft.json`, not an accepted manifest. The draft deliberately has no licence object and
remains outside `assets/aircraft/registry.json` until proof of the applicable Pro-plan acquisition,
the applicable licence/vendor-terms snapshot, confirmation of source-image rights and human
approval of `salvage-preview.png` are attached. Semantic inference is reviewable; it is not treated
as artist-authored truth or rights evidence.

## Pipeline stages

1. `evaluateAircraftAssetSubmission` separates technical invalidity, missing evidence and blocked
   distribution rights before model processing starts.
2. SHA-256 and byte size bind the decision, licence evidence and delivered GLB to the same bytes.
3. Khronos' official glTF Validator checks the GLB container and glTF 2.0 rules with timestamps
   disabled. Tailfin then checks the project contract against the decoded model itself.
4. glTF-Transform performs deterministic deduplication, welding, vertex reordering and pruning.
   Empty anchor nodes and `TEXCOORD_1` are retained deliberately. Evidence-gated Meshopt output is
   supported without quantising the livery UV contract.
5. The derived GLB is decoded and validated again. Triangle counts, bounds and per-LOD livery-UV
   fingerprints must still match the source inspection.
6. The tool emits the runtime GLB, canonical JSON report, deterministic SVG comparison and the
   canonical registry entry. It then makes that asset version active for new work.

Source LOD0, LOD1 and LOD2 are validated rather than generated. That is the deliberate side of
M6-12's “generate or validate supplied LODs” choice: a generic simplifier cannot prove that an
artist-authored livery island or protected-material boundary still means the same thing.

## Tailfin checks

The project layer verifies:

- one scene, an actual scene-root matching `rootNode`, exact stable node/mesh/material names and no
  undeclared resources;
- identity transforms on the root and every mesh-bearing node, unit-scale anchors, the ground
  contact at the world origin, measured LOD0 bounds and a ground plane at `Y = 0`;
- exact manifest material coverage, no unbound or unused meshes/materials/textures, and required
  base-colour, normal and metallic/roughness slots on paintable materials;
- `TEXCOORD_1` on every paintable primitive, normalized coordinates, non-degenerate UV triangles,
  spatially indexed triangle-overlap detection, and explicit mirrored-surface allowances;
- exact supplied LOD triangle counts, the 50%/20% ratios, consistent paintable materials and UV
  bounds across all three LODs;
- the default no-animation/no-camera/no-light/no-custom-metadata policy. An intentional retained
  object must be named in the decision; an unnamed allowance is impossible;
- declared versus measured draw calls, materials, texture dimensions, conservative RGBA8 GPU
  texture memory, geometry upload bytes and profile ceilings.

The unit suite builds real GLBs and sends them through both validators. It covers deterministic
repeat intake, broken UVs, undeclared network resources, missing pilot protected materials,
out-of-budget policy, orphan registry files and rollback.

## Deterministic identity

The content identity is SHA-256 over canonical JSON containing:

- pipeline version and the pinned glTF-Transform, glTF Validator and Meshoptimizer versions;
- source GLB hash;
- canonical manifest hash;
- canonical optimisation-decision hash.

It generates this path, with no hand-written component:

```text
runtime/<asset-id>/<asset-version>/<content-identity>/aircraft.glb
```

The report and comparison SVG use the same directory. If that identity already exists and newly
generated bytes differ, intake refuses to overwrite it and requires a pipeline-version bump. This
turns a hidden nondeterminism into a blocking error instead of silently changing an immutable URL.

## Compression is an evidence decision

The decision records source/runtime bytes, p95 GPU upload time, pilot assets, reviewer and date, and
a written visual review. Meshopt cannot be selected without measured byte savings. KTX2 is currently
passthrough-only: all material textures must already be KTX2 and the decision must show byte savings
and a measured upload time. Tailfin will not add a lossy transcode preset until representative ATR,
narrowbody and widebody pilots provide the visual and performance evidence for one.

“Retain” and “lossless” are valid measured decisions. The pipeline removes unused resources and
reorders/welds geometry without pretending that switching on every codec is automatically an
optimisation.

## Registry, CI and rollback

`assets/aircraft/registry.json` retains every admitted version. Each entry has source and runtime
hashes, generated artifact paths, byte sizes, conservative GPU estimates, geometry/material/LOD
statistics, exact livery binding, renderer compatibility and tool versions. `pnpm assets:validate`
checks every referenced file and fails any runtime GLB that has no registry entry. CI runs it on
every pull request and `main` push.

`activeAssetVersions` is only the default for new work. Published livery documents resolve their
exact four-part binding and never consult that pointer. Rollback therefore changes one selection
while retaining both registry entries:

```bash
pnpm assets:rollback -- \
  --root assets/aircraft \
  --asset a220-300 \
  --version 1.0.0
```

The command does not rewrite a published livery, delete the superseded GLB or resolve anything
through `latest`.

## Budget exceptions

A measured ceiling failure blocks by default. An exception must name a Tailfin GitHub issue, the
exact exceeded metrics, approver, approval and expiry dates, and a substantive justification. CI
accepts it only while current and only when it covers every measured excess. An expired or partial
exception fails; an exception on an asset that is now within budget remains visible as a warning
and should be removed.

Exceptions do not authorize a broken GLB, unsafe URI, invalid UV, rights failure or semantic drift.
They cover measured budgets only.
