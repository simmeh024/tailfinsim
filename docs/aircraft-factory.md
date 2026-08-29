# Aircraft factory: guarded generation and review boundaries (M6-25)

The factory prepares candidates for the existing [licensed intake](aircraft-3d-assets.md) and
[deterministic runtime pipeline](aircraft-asset-pipeline.md). It does not replace either admission
gate, the v2 livery document, or VIS output ownership. The live dependency-ordered programme is
[epic #716](https://github.com/simmeh024/tailfinsim/issues/716) in
[M6 · Design Tools](https://github.com/simmeh024/tailfinsim/milestone/7).

## What the command does

`pnpm assets:meshy` is **offline preflight only**. The package script builds the CLI into ignored
`dist/`, then runs a read-only preflight. That preflight has no API transport, account lookup, task
submission, download, registry mutation or output-file writer. It reads the checked-in
`assets/aircraft/generation/a320neo-t2-v1.json`, validates the pinned strategy and emits canonical
JSON. Prompt contents are represented by hashes, not copied into the report.

From the repository root:

```bash
pnpm assets:meshy -- --help
pnpm assets:meshy -- --dry-run
pnpm assets:meshy -- --dry-run --max-credits 40
```

The number supplied to a dry-run is a **proposed ceiling**, not recorded user approval. Missing
ceilings and plans that do not fit are reported explicitly. Values outside integer `1..40`, duplicate
options and any attempted live mode are refused. A successful dry-run does not mean a run is ready:
`spendAuthorized` and `liveExecutionAvailable` are always false. API authentication/balance,
reference-image rights and licence evidence remain unverified.

For a local credential-shape check, set `MESHY_API_KEY` in the invoking process, or add
`--key-file` with the path to a plain UTF-8 file containing just the key. An explicitly supplied file
takes precedence over the environment. No environment file is automatically sourced, and the tool
does not search the desktop or other directories. The file is read only and bounded to 4 KiB; the
specification is bounded to 16 KiB. Key contents, file paths and underlying parser/OS error text do
not appear in the report. `present` means the local shape looks plausible, **not** that Meshy
authenticated it. Never pass a key value in arguments, commit it, or use a `VITE_` variable.

The pure accounting kernel reserves credits before an operation, rejects duplicate reservations
and binds the budget to a specification hash. Unknown outcomes retain their reservation. A smaller
reported charge does not release speculative retry capacity; an unexpected overcharge is retained
and prevents further reservations. This kernel alone is **not a durable ledger**; use the SQLite
run wrapper below for reservations and receipts. Retexture transport and uncertain-submission
reconciliation remain [#791](https://github.com/simmeh024/tailfinsim/issues/791) follow-ups.

## One approved run and a read-only account check

The separate `assets:meshy-run` command stores one immutable first-run approval and supports a
read-only provider balance check. It does **not** change `assets:meshy --dry-run`: that command
still has no network activity, ignores run approval and always reports spending unavailable.

```bash
pnpm assets:meshy-run -- --help
pnpm assets:meshy-run -- init --approval-file /private/approval.json
pnpm assets:meshy-run -- status
pnpm assets:meshy-run -- account --max-credits 40 --key-file /private/meshy.txt
pnpm assets:meshy-run -- sync --operation candidate-1 --max-credits 40 --key-file /private/meshy.txt
```

Use `init` only after actual user approval. Its strict `MeshyRunApproval` input binds the consent
artifact's SHA-256 and task ID, recorded timestamp, exact spec hash, first-run scope and approved
integer ceiling. Preserve the original consent artifact privately; a fabricated approval JSON is
not consent. Initialization refuses an existing store rather than replacing the allowance.
Account checks must pass **the same** ceiling; `40` above is an example, not blanket approval.

The store is in the Git common directory at `tailfin-aircraft-factory/a320neo-first-run.sqlite`,
shared across this repository's linked worktrees. No CLI override can create another first run.
Reservations commit before each paid call, unknown outcomes block further reservations,
task identities cannot be reused, and retexture reservation requires one recorded human selection
after four terminal candidates. Selection records refer to evidence; the tooling cannot substitute
for the actual human review. Candidate submission is available below; selection and retexturing
are not exposed by this CLI.

`account` makes only a fixed-host HTTPS GET, bounded to three attempts, ten seconds each and
4 KiB decoded JSON. It reports authentication, numeric API balance and whether that balance covers
the approved ceiling. No key, key path, raw provider error or signed output URL is emitted or
stored. An explicit key file overrides `MESHY_API_KEY`; neither is installed on a server. The
command spends zero generation credits and does not verify subscription/private-license terms.
[Meshy balance contract](https://docs.meshy.ai/en/api/balance).

`sync` performs one bounded read-only polling pass for a **previously recorded** candidate task.
It cannot adopt an arbitrary task ID, resolve an uncertain submission, submit/retry generation,
select a candidate or retrieve retexturing outputs. Repeat the command to resume a pending task.
Task GETs use the fixed Image-to-3D endpoint, at most three attempts, ten seconds per attempt and
64 KiB decoded JSON. Repeated status/charge observations retain their first durable timestamp,
including concurrent polls, so progress polling does not exhaust the ledger's snapshot limit.
Terminal charges are committed before attempting a download; expired/broken URLs cannot erase them.
Mid-flight charges are reported but not confirmed as terminal. Paid submissions serialize
candidates until earlier tasks have terminal charges, and stop on any price increase.

Successful, charged candidates archive their untouched GLB under the Git-common directory's
`tailfin-aircraft-factory/a320neo-first-run-exports/`. The downloader accepts only HTTPS
`assets.meshy.ai`, refuses redirects and never forwards the API credential. GET attempts are bounded
to three, thirty seconds each and 64 MiB decoded bytes. A GLB v2 container-envelope check is **not**
glTF conformance, self-containment, topology or visual approval; embedded/external resources are not
loaded or executed. This first increment archives the requested GLB only, not provider thumbnails,
alternate formats or separate PBR maps. Retexture archival needs its own gate before paid texturing.

Files use content hashes and exclusive atomic publication. The sanitized completion manifest is
written last and binds approval/spec/request/task/export identities; it excludes raw provider
messages and signed URLs and explicitly marks evidence incomplete and runtime admission unreviewed.
Existing complete archives are hash-verified without provider access. Corrupt/missing objects,
conflicting manifests and symlink/junction/hard-link redirection fail closed without overwriting.
Interrupted writes may leave `.pending-*` files for operator inspection. File data is flushed;
directory flush is available on POSIX but not through Node on Windows. Preserve/back up archives
separately from the active credit ledger; never restore an old ledger to recover an export.
[Meshy API outputs expire after three days outside Enterprise](https://docs.meshy.ai/en/api/asset-retention).

The quarantine-only provenance descriptor records task IDs and content identities, including an
input task for retexturing. Incomplete rights, plan, terms, reference and export evidence cannot
become a licensed runtime asset. Use `provenance` after export archival to verify and seal its linked
evidence. A Pro receipt alone does not establish reference or aircraft-design rights.

Recovery is fail-closed: **do not delete or rewind the ledger**. An incomplete/corrupt store, lost
response or capacity limit requires reconciliation, not a fresh `init`. Preserve its journal too.
Use a local filesystem, not a network share, and do not move an active run between clones/hosts.
See [ADR-0024](adr/0024-local-aircraft-generation-authority.md) for durability, bounds, consent and
workstation-trust limitations. No shared livery/asset admission or application database changes.

## Verified evidence and one-shot candidate submission

This is a deliberately bounded **first-run** operator workflow, not yet a general fleet factory.
It requires the existing approval and the same explicit ceiling on every invocation:

```bash
pnpm assets:meshy-run -- prepare --evidence-file /private/evidence-import.json --max-credits 40
pnpm assets:meshy-run -- submit --operation candidate-1 --pricing-file /private/pricing-review.json --max-credits 40 --key-file /private/meshy.txt
pnpm assets:meshy-run -- sync --operation candidate-1 --max-credits 40 --key-file /private/meshy.txt
pnpm assets:meshy-run -- provenance --operation candidate-1 --max-credits 40
```

`prepare` is offline and refuses preparation after any reservation. Its strict input has
`format: "tailfin-meshy-evidence-import"`, `formatVersion: 1`, `review` and `files`.
The complete review contract is in `packages/assets/src/meshy-evidence.ts`; it records actual
operator observations, not machine-certified ownership. All nine file roles are required:
`referenceImage`, `referencePrompt`, `parentImage`, `parentPrompt`, `authoringRecord`,
`termsSnapshot`, `ownershipSnapshot`, `privatePlanEvidence`, `consent`. The original two-image
AI-authoring chain must bind both images and prompts by hash, declare no third-party image input
and explicitly record that the authoring tool did not disclose its model version. This first-run
contract intentionally does not accept arbitrary imported reference-image rights declarations.

Preparation copies original bytes into immutable hash-addressed private evidence beside the
Git-common ledger, then writes `prepared.json` last. Images must be single-frame PNG, at most 4 MiB,
4096 pixels per dimension and 16,777,216 decoded pixels; APNG is refused. Text/JSON, HTML and PDF
have separate size/type limits. The PDF is retained opaquely and never evaluated by the CLI:
magic bytes are not proof of a valid receipt, so prior human visual review is mandatory. Consent
bytes must match the existing approval. A changed prepared record cannot overwrite the original.

`submit` accepts only candidate-1 through candidate-4, in order, with one fixed PNG and exact
pinned T2 settings. It re-verifies every evidence byte, including terms and private plan evidence,
checks the paid period and obtains a fresh balance that covers the entire approved ceiling.
The strict pricing import contains `format: "tailfin-meshy-pricing-review"`, `formatVersion: 1`,
the exact official pricing `source`, `reviewedAt`, `reviewedBy: "local-operator"`,
`untexturedCandidateCredits: 5`, `selectedRetextureCredits: 10`, `snapshotFile` and a
`snapshot` digest/byte-count/`text/html` descriptor. The operator must actually inspect current
pricing; timestamps must be no older than one hour and not future-dated. The snapshot and review
are preserved immutably; a refreshed pricing review does not change the reference bundle.

Only the reference PNG is sent to Meshy. **Receipt, consent, terms, prompts and key file are never
uploaded.** The API credential is used only in the fixed API-host Authorization header. A private
submission proof binds actual request-body hash, prepared evidence, pricing evidence, sanitized
account readiness, authorization time, approval and specification. Its hash is committed in the
durable reservation before exactly one POST (30-second deadline, no redirects, 4 KiB JSON receipt).
HTTP errors, malformed responses, lost connections and receipt-persistence failures all retain
the reservation and halt; **never retry an uncertain POST**. The CLI does not adopt provider tasks
automatically. Preserve the ledger and reconcile with the provider before any further paid work.

Prior tasks must have terminal charges; successful outputs must also be locally archived and
hash-verified before the next submission. Failures/refunds never release a slot or reservation.
The transaction rechecks sequencing, so concurrent processes cannot both authorize the same or
next candidate. A pricing review is an operator attestation, **not a provider-enforced quote**:
the local ceiling limits approved reservations, cannot prevent a vendor from overcharging one
already-submitted request, and stops all further spending when a higher actual charge is reported.

`provenance` is an offline, idempotent seal linking the successful untouched export to the exact
spec, task/timestamps and verified private evidence chain. It remains usable after the subscription
period ends by checking historical submission authority; it cannot grant new spending authority.
All four licence/technical/visual/performance reviews remain pending. Keep evidence and provenance
private: only reviewed runtime derivatives may later be admitted. A Pro receipt represents the
user's account assertion, not a cryptographic link between that receipt and the API key.

Pro/private output is not a general training opt-out or aircraft-design clearance. Terms and
reference-input rights still require admission review; never post candidates to Meshy Community.
See [Meshy ownership guidance](https://help.meshy.ai/en/articles/10137554-what-is-the-ownership-of-the-generated-models)
and [data/training guidance](https://help.meshy.ai/en/articles/15724182-is-meshy-safe-and-private-data-and-training-faq).
There is no automated winner selection, paid retexture, fallback geometry experiment or fleet
publication in this increment. After four candidates, stop for human comparison/selection (#792).

## Offline candidate geometry audit (M6-26)

After archival, inspect one candidate without credentials, provider requests or credit authority:

```bash
pnpm assets:meshy-run -- audit --operation candidate-1
```

`audit` accepts only the recorded candidate-1 through candidate-4 operations. It rejects key,
budget, URL and arbitrary input/output path options. The ledger and source are read only;
the command verifies the archived task/export identity, then seals canonical JSON as
`candidate-N-geometry-v1.json` beside the private exports. The report binds exact source bytes,
task, approval, specification and algorithm version. Identical reruns are idempotent; conflicting
reports or modified source bytes fail closed. Never delete a report to accommodate a changed
algorithm: introduce a new report/algorithm version instead.

The first decoder intentionally supports only untextured GLB v2 with one embedded buffer, one
flat scene, identity-transform nodes and triangle primitives. Each mesh is instantiated once.
Positions/normals/UVs use FLOAT accessors; indices may use unsigned byte, short or integer.
It permits an empty root `extensions` object but refuses nonempty extensions, external resources,
textures/materials, sparse accessors, skinning, morphs and hierarchy/transforms. Unsupported inputs
produce a code-owned diagnostic without model-provided names, paths or parser errors. This is a
bounded intake profile, **not official glTF conformance validation**.

Limits are 64 MiB GLB, 1 MiB JSON, 64 nodes/meshes, 256 total primitives, 1,024 accessors/views,
100,000 source vertices and 100,000 triangles. Accessor ranges, stride/alignment, finite values
and index bounds are checked before use. Coordinates are bounded to absolute 1,000,000 source
units. Declared accessor bounds are ignored; measured bounds use referenced vertices only.

Measurements include triangle/vertex counts, exact coincident positions, duplicate faces ignoring
winding, and degenerate faces (collapsed indices or double area at most `1e-12` after normalization
by the longest bound extent). Exact-coordinate welding is **analysis only**: original bytes never
change. Edge topology and edge-connected component sizes exclude duplicate/degenerate faces.
The report counts boundaries, edges with more than two incident faces, and inconsistent winding
on two-face edges. Only the largest 64 component sizes are listed, with an omitted count.

The symmetry indicator reflects occupied **vertex** voxels about each native axis midpoint at
256 cells per longest extent and computes intersection-over-union. It is density-sensitive, not
surface/silhouette symmetry, and cannot choose canonical axes or rank aircraft automatically.
Source extents are not metres or an A320neo dimension check. Attribute presence is not canonical
UV coverage, semantic segmentation, or proof of correctly oriented normals.

Every report remains quarantined and explicitly not livery-ready. Zero edge defects do not prove
watertightness, vertex manifoldness or absence of self-intersections. Components are not identified
as engines or other semantic parts; boundary edges can include intentional part openings. Licensing,
official conformance, axes/dimensions, silhouette, engine placement, canonical UV/masks, protected
materials and visual/performance review remain pending. Human selection is not asset admission.
This increment neither repairs the source nor submits retexturing, changes a livery/asset schema,
updates the registry or publishes to fleet.

## Quarantine component review preparation (M6-27)

```bash
pnpm assets:meshy-run -- review --operation candidate-1
```

`review` is offline and accepts only the recorded candidate operation, with no credential,
budget or input/output path options. It rechecks the untouched archive against the ledger,
creates a **separate review derivative**, validates that derivative with the pinned official
glTF validator, then seals `review-<sha256>.glb` and `candidate-N-review-v1.json` beside the
private exports. The report is the completion marker, written last. Existing identical artifacts
are verified; changed source, derivative or report bytes fail closed. Interrupted writes may
leave an unreferenced derivative; a rerun can complete the same immutable report. The source,
credit ledger, human selection, registry and existing v1 audit reports are not rewritten.
The terminal prints only a compact summary and artifact basenames; full geometry/face mappings
stay in the private report instead of being copied into logs.

This is not canonical aircraft intake. The input must fit the bounded audit profile and contain
exactly one primitive without authored normals or UVs: preparation refuses to drop those attributes
or merge authored primitive boundaries. It removes only exact zero-area faces and exact
same-winding duplicates, recording source triangle indices and retained twins. Positive near-zero
faces at the audit's `1e-12` normalized double-area threshold are refused for manual review, not
deleted. Opposite-winding coincident faces are **preserved and flagged** as ambiguous two-sided
geometry. Bounds must remain exactly unchanged after cleanup.

Exact-coordinate edge connectivity produces up to 64 individually named review components,
ordered by first retained source triangle. IDs such as `review_component_001` are stable only for
the **exact source**; they are not aircraft semantic names or reusable cross-version bindings.
Each component records its original face indices, source-unit bounds and boundary segments.
Coincident faces count once for connectivity/boundary analysis, including preserved opposite
winding faces. Vertex-touching surfaces alone are not joined. Every semantic/protection assignment
is unassigned; none becomes paintable by default.

The output retains positions and winding, expands triangle corners and supplies flat face normals.
It does not smooth, approximately weld, cap openings, flip winding, remove disconnected parts,
normalize scale/axes/origin, author UVs or infer engines/windows/doors. Flat normals are a diagnostic
display aid, not proof of outward-facing geometry or finished shading. Up to 33,333 retained triangles
fit the audit's 100,000-vertex limit after expansion; report JSON is capped at 8 MiB. The output is
deliberately larger and draw-call heavier than a shipping asset and must not enter the runtime registry.

The report binds source/derivative/task/spec/approval hashes, algorithm and validator versions,
before/after metrics, removed faces and unresolved coincident faces. Zero validator errors/warnings
completes conformance only. Licensing, real-world dimensions, semantic/protected surfaces, winding,
holes, canonical UVs and visual/performance admission remain separate gates. These artifacts enable
component inspection and an explicit repair plan; they do not certify a completed aircraft.

## Canonical frame assessment (M6-27)

```bash
pnpm assets:meshy-run -- frame --operation candidate-1 --axis-review-file /private/axis-review.json
```

`frame` is a zero-credit, assessment-only successor to `review`. It requires the immutable source,
the completed review report/derivative and a strict private axis-review record containing the exact
source hash, `local-operator` identity, review time, a right/up/forward declaration and at least two
SHA-256-bound visual evidence items. It accepts no credential or budget option. The source axes must
be distinct and right-handed; they map to Tailfin's established `+X right, +Y up, -Z forward` frame.

The A320neo target is pinned to Airbus's June 2026 facts and figures: 37.57 m overall length,
35.80 m wingspan and 11.76 m overall height. Length and span are assessed with one least-squares
uniform scale and a conservative 2% per-dimension tolerance. Non-uniform scaling is forbidden: it
would conceal a proportion error by distorting the fuselage, wings, engines and livery coordinates.
Overall height is recorded but is not an admission comparison for a gear-up source because Airbus's
ground-to-tail dimension includes the operational ground reference. The proposed gear-up origin is
the X/Z bounds centre with the lowest visible geometry at Y=0; this is explicitly not certified
landing-gear contact. [Airbus A320 Family facts and figures](https://mediaassets.airbus.com/pm_38_914_914157-tlwvtuuhjj.pdf?fileName=airbus-a320-family-facts-and-figures-june-2026.pdf).

The command seals `candidate-N-frame-v1.json` last and never emits a transformed GLB. A failed fit
stays useful evidence but sets `eligibleForCanonicalTransform: false` and keeps the candidate in
quarantine. Candidate 1's reviewed native axes are source `-Z right`, `+Y up`, `-X forward`. Its
source length/span ratio differs materially from the Airbus target: the best uniform fit proposes
about 36.16 m length and 37.17 m span, approximately -3.76% and +3.84%. It therefore fails the 2%
gate. Geometry correction or a better candidate is required before axes/scale/origin may be baked;
the tool does not silently stretch the chosen mesh.

## Quarantined proportion correction (M6-27)

```bash
pnpm assets:meshy-run -- correct --operation candidate-1
```

`correct` is an explicit geometry-authoring step enabled only after the immutable frame assessment
has failed. It accepts no file, key or budget option, rechecks the source/frame/review identities and
creates a new immutable derivative; it never overwrites the untouched Meshy export or review GLB.
The result is still quarantine-only, with no semantic classes, paint protection, UVs, registry entry
or fleet binding. The pinned glTF validator must report zero errors and warnings before the GLB and
completion report are sealed.

For candidate 1, the correction first applies the reviewed canonical axes and a uniform scale that
preserves Airbus's 37.57 m overall length. It preserves the 3.95 m centre-body width and remaps only
the outboard lateral coordinate to the 35.80 m sharklet span. The largest connected review component
receives the continuous outboard remap. Every smaller disconnected component retains its local shape
and is moved laterally as a rigid piece according to its bounds centre; this avoids squeezing the two
detached nacelle-like components while making no semantic claim about them. Flat normals are then
regenerated from the retained face winding. [Airbus A320 Aircraft Characteristics — Airport and Maintenance Planning, §2-2-0](https://www.aircraft.airbus.com/sites/g/files/jlcbta126/files/2024-06/AC_A320_0624.pdf).

The candidate 1 derivative measures 37.5699997 m long and 35.7999992 m wide after float32 encoding;
the maximum vertex displacement is 1.4131 m. Source/review triangle count remains 15,423. Private
derivative SHA is `ed13353213acee53158f3f20aa8a3184ddea53172e94ba8336ee9fa47d5257ff`;
report SHA is `ee2a4d201ebb84abea3e3a1b42d27ef1651bcb7926559650dfb12dc5d19c176e`.
Standard-angle browser review shows both detached nacelle forms retained and the wing tips within
frame; it does not resolve the pre-existing rough nose/nacelles, mixed main component, disconnected
marking-like pieces, openings or missing protected windows/doors. Those remain blocking semantic and
topology work, not reasons to pretend the dimensional correction is a completed aircraft.

## Semantic component inventory (M6-27)

```bash
pnpm assets:meshy-run -- inventory --operation candidate-1
```

`inventory` is a zero-credit evidence step over the exact corrected derivative. It records each
source-scoped component's canonical bounds, triangle range, geometric side and up to three
opposite-side mirror candidates. Mirror scores compare centres, extents and triangle counts; they
are review aids only and never assign an aircraft semantic. Components crossing X=0 are explicitly
flagged for triangle-level review rather than being treated as a ready fuselage, wing or tail mesh.

The report also records the complete target mesh inventory. Side-specific mesh identities map onto
the existing coarser material classes: for example, `wing_left` and `wing_right` both use the
paintable `wings` class, while `cabin_windows_left` and `cabin_windows_right` both use the protected
`cabin_windows` class. Doors remain dedicated decals or masks rather than holes. This means the
factory can satisfy the required mesh detail without changing the shared livery/material-binding
data model. Missing glazing, doors, lights or engine interiors remain missing; the inventory cannot
infer geometry into existence or declare the candidate livery-ready.

The immutable `candidate-N-semantic-inventory-v1.json` is bound to both the proportion-correction
report and derivative hashes. Re-running it must reproduce identical bytes. It does not change the
run ledger, source, derivative, registry or fleet state.

Candidate 1 produces 20 component records. Only `review_component_002`, the 9,842-triangle mixed
main body/wing/tail component, crosses the centre plane and is therefore forced into triangle-level
review. The strongest whole-component bilateral evidence includes 001/004, 006/020, 008/009,
010/011, 012/014 and 016/017; these are geometric pairs, not engine, window, door or light labels.
The immutable inventory report SHA is
`0127aaa892132b5ea5f1d4851ff3f93dfe9b91067952541fb45cab8781b14001`.

## Pinned strategy and vendor evidence

The planning observation is dated 2026-08-28. Four untextured T2 candidates cost 5 credits each;
one selected 2K/4K retexture costs 10: a **30-credit plan**, with an explicitly approved first-run
ceiling no higher than 40. API pricing must be checked again before spending; a subscription balance
is neither API readiness nor permission to spend. [Meshy API pricing](https://docs.meshy.ai/en/api/pricing).

The geometry request pins `smart-topology`, `meshy-t2`, a 15,000-face target and no texture phase.
T2 supplies triangle geometry and native parts; those parts still need semantic review. Remesh and
topology selectors are ignored for Smart Topology, so the spec omits them. Do not claim the
deprecated symmetry parameter guarantees symmetry. [Image-to-3D contract](https://docs.meshy.ai/en/api/image-to-3d).

Retexturing pins Meshy 7 **for texture generation**, not as a geometry fallback, with 4K PBR and
new source UVs before canonical paint UV authoring. Only a human-selected successful candidate may
be submitted by the future client. [Retexture contract](https://docs.meshy.ai/en/api/retexture).

Multi-Image is a separately approved geometry experiment, not part of this Smart Topology run.
Do not use Auto Split for livery segmentation or treat 8K texture resolution as extra geometry.
The neutral reference prompt in the spec is an authoring instruction, not an image, evidence of
image rights, or a claim that Image-to-3D accepts a geometry text prompt.

## Ownership and sequence

| Stage                       | Existing or added owner                                                                                                | Output and review boundary                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A / architecture            | [#716](https://github.com/simmeh024/tailfinsim/issues/716), ADR-0021                                                   | Reconcile contracts before schema changes                                          |
| B / spending and provenance | [#791](https://github.com/simmeh024/tailfinsim/issues/791)                                                             | Explicit approval, durable reservations, immutable candidate evidence              |
| C / selection               | [#792](https://github.com/simmeh024/tailfinsim/issues/792)                                                             | Rights-cleared neutral reference, four scored candidates, human selection          |
| D / canonical preparation   | [#793](https://github.com/simmeh024/tailfinsim/issues/793)                                                             | Repaired semantic geometry and independently reviewed rights                       |
| E / mapping resources       | [#794](https://github.com/simmeh024/tailfinsim/issues/794)                                                             | Exact UV/mask/anchor resources and protected coverage                              |
| F / delivery and viewer     | [#795](https://github.com/simmeh024/tailfinsim/issues/795), [#720](https://github.com/simmeh024/tailfinsim/issues/720) | Boundary-locked LODs, compression, staged loading and measured budgets             |
| G–H / rendering and tools   | [#721](https://github.com/simmeh024/tailfinsim/issues/721)–[#725](https://github.com/simmeh024/tailfinsim/issues/725)  | Shared compositor, synchronized 3D/map, editable graphics and finishes             |
| I / publication and outputs | [#726](https://github.com/simmeh024/tailfinsim/issues/726)–[#728](https://github.com/simmeh024/tailfinsim/issues/728)  | Exact fitting, immutable versions, impact preview/apply/rollback; VIS owns outputs |
| J–K / proof and rollout     | [#729](https://github.com/simmeh024/tailfinsim/issues/729)–[#731](https://github.com/simmeh024/tailfinsim/issues/731)  | Security/performance/accessibility, A320neo dev comparison, then 787/ATR and fleet |

The issue bodies carry acceptance criteria, test/E2E selection, dependencies and review gates;
GitHub is authoritative for progress. M6-01–03 and M6-10–12 are reused. Do not reopen the superseded
SVG-era M6-04–07, create a second catalogue, or duplicate VIS storage/cache/version entities.

## Architecture audit: decisions still required

Inspection at main `4f4f8e8` on 2026-08-28 found these boundaries. This is a dated audit, not a
continuously maintained progress summary; follow the issues for subsequent resolutions.

- `LiveryDocument` v2 already stores semantic layers and exact aircraft/UV/material/anchor tuples.
  Finish/group semantics are absent. Review a backward-compatible extension and migration before
  adding those fields; never store textures or GPU objects in the document.
- `AircraftAssetLicenceEvidence` v1 has no AI-generation/reference-rights/private-plan shape.
  Candidate provenance needs a sidecar, then an explicit admission-schema decision. Do not label
  generated output `in_house` to evade this gap. Rights evidence must link the untouched export to
  canonical derived hashes, not merely repeat a subscription name.
- Meshy parts are not guaranteed semantic meshes. Left/right windows and engines, closed opaque
  glazing, doors as overlays/masks, protected materials and logical-artwork mappings require
  canonical preparation. The ground-centre origin contract also needs an explicit gear-up reference
  interpretation, not a silent origin change.
- The current pipeline validates supplied LODs; it does not generate them. KTX2 is passthrough-only.
  The 15k/7k/2k–3k runtime targets are stricter than source admission ceilings, not replacements for
  them. New codecs and per-stage registry paths need reviewed versioned extensions.
- `DevelopmentAircraftPreview` is a quarantined A320-specific approximation: hardcoded endpoints,
  whole-surface primary colours, no true gradient/text/decal mapping, and double-sided material
  workarounds. It is not evidence of repaired topology or a canonical livery compositor.
- The UI reference contains gear-down/sample-identity/latest-like details. Treat it as a workflow
  and visual target; the explicit brief's gear-up generation and exact published bindings win.
- `airline.logo` is mutable brand-identity data with rebrand economics. Reuse it only through an
  immutable livery-resource snapshot; do not couple repainting to an accidental airline rebrand.
  Bounded safe SVG/PNG import now belongs to M6-17, superseding its older upload exclusion.
- Server `livery_id` fields are placeholders, not immutable version relations or publication APIs.
  Publication must be ownership-authorized, transactional, validated and audited. M6-20 produces
  publication identities; VIS-03 consumes them, avoiding the former reciprocal dependency.
- The runtime registry is currently code-delivered. “Rollback without any deploy” is not an
  implemented property. Retaining exact old resources and explicitly changing a default pointer
  must not silently retarget a published UV layout.

No shared livery/asset schema, database model, candidate geometry or runtime renderer is changed by
this offline foundation. The existing Hi3D salvage and unlicensed STL are not promoted.

## Candidate evidence and release policy

Future live runs preserve the exact reference image and its rights, authoring prompt, settings,
provider/model/task IDs, generation timestamps, plan/private-license evidence and applicable terms
snapshot. Untouched exports, all derived artifacts and review reports have SHA-256 identities.
Keep private evidence and model experiments outside source or under gitignored `.aircraft-factory/`.
No credential belongs in a manifest. A numeric quality score cannot substitute for licensing,
semantic, visual or performance approval.

Review white, very dark and split paint plus tail logos, titles, registrations/flags and engine
branding from left/right/top/underside/nose/tail views. Explicitly inspect cockpit and cabin windows,
doors, nacelles, wing roots and winglets. Structural/perceptual tests complement human review;
reference-device measurements establish shipping budgets.

Use small PRs and green required CI. Deploy reviewable runtime increments to **dev at the exact
green merge SHA**, with the documented post-deploy checks. Production publication remains a
separate user approval. This operator-only foundation needs no Meshy credential on either server,
no database access and no paid generation in CI.
