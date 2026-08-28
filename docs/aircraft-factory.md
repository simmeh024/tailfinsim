# Aircraft factory: offline preparation and review boundaries (M6-25)

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
and prevents further reservations. This is **not yet a durable ledger**: single-writer locking,
atomic write-ahead storage, crash recovery, task reconciliation and explicit approval records must
land under [#791](https://github.com/simmeh024/tailfinsim/issues/791) before any live client is enabled.
No caller should infer cross-process/concurrency safety from this pure kernel.

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
