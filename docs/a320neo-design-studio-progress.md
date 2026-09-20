# A320neo Design Studio progress review

The development Design Studio (`https://dev.tailfinsim.com/design`) opens the
A320neo in **Model progress**. It displays the reviewed aircraft and its sample
livery, preserving imported paint maps, UV channels and material values. Draft
editing remains available through **3D preview** and **Paint map**; changing the
view does not change the saved draft. Other families and non-dev environments
keep the existing preview.

**Tail detail** frames the complete fin from starboard. Reset restores the front
quarter view. Both views fit the actual mesh vertices to the viewport, retaining
the whole subject when the panel changes size. Orbit, close zoom and right-drag
pan support surface inspection; resizing preserves a manually adjusted view.
An unavailable model reports a fallback explicitly rather than presenting the
illustrative fleet image as current progress.

## Reviewed artifact

- Source: `artifacts/aircraft-quality-v4/anchors-detail-round-1/aircraft-anchors-v4.glb`
- SHA-256: `b7b2bf6cc1adb6e1df06948b00e70682f74701f7012c080a70c009f28ac19fcc`
- Size: 2,865,836 bytes; 18 meshes; 65,264 triangles; 4K sample paint.
- Modeling source revision: `ced8ed4` on `codex/a320neo-visual-quality`.
- Operator file: `/srv/tailfin-dev/.quarantine/a320neo-progress/aircraft-b7b2bf6c.glb`.
- Environment key: `DEV_QUARANTINE_A320NEO_PROGRESS_GLB`.
- Endpoint: `/api/dev/assets/aircraft/quarantine-a320neo-progress.glb`.

The optional endpoint follows the existing dev quarantine bridge, with an
explicit filename and `private, no-store`. It does not admit the aircraft or
livery to the runtime registry. The progress model is a review artifact, with
final material polish, branding, runtime LODs and admission still outstanding.

## Verification and deployment

Focused React tests cover delayed dev identity, default progress selection,
switching previews without losing paint, and other-family fallback. Server tests
cover provisioned/unavailable/prod route behavior and the environment guard.
The nightly browser test covers missing-model fallback and draft persistence.
The full authenticated nightly test requires the normal disposable E2E database;
it must never run against the live development database.

The actual model was inspected in the browser using the Design Studio component,
including front quarter and complete-fin close-up. Deployment uses
`./deploy/deploy-dev.sh codex/a320neo-studio-progress` on the dev web host, then
checks its normal post-deploy smoke and the public GLB's hash. Previous dev code
was `b5573e0`; the progress environment key was previously absent. Restore that
code with the dev deploy wrapper and remove only this key if rolling back.

## Enforced-CSP follow-up

Signed-in review of build 880 found that embedded GLB paint images failed under
the deployed CSP, leaving a white aircraft despite a successful geometry load.
The uncompressed progress path also unnecessarily imported the WebAssembly
meshopt decoder. A standalone viewer without CSP had not exposed these failures.

The viewer now reads embedded image buffer views into data URIs and uses Three's
HTML-image texture loader. This uses the existing `img-src data:` allowance;
the Caddy policy remains unchanged. The meshopt module is loaded only by the
legacy compressed-model stages. The builder's grid column can shrink, its header
wraps, and badges/hints stay inside the viewer when the shell's layers panel is
open.

The same regression caught inline blend styles in Paint map. Embedded paint
maps now select blend modes through data attributes and the application CSS;
standalone SVG output retains its self-contained inline styles by default.

A synthetic textured-GLB browser regression is in the PR smoke suite. It applies
the actual Caddy policy to the page, rejects texture/CSP/decoder errors, checks
controls against the shell stage bounds, and returns from Paint map to the
model. The real reviewed aircraft was also inspected in a compiled local viewer
under the enforced policy, at the live editor's constrained width.

## Studio quality pass

The progress viewer now uses a locally generated studio environment for soft
reflections and clearer glass, paint and engine surfaces. It retains the reviewed
GLB's geometry, UVs and material parameters. The temporary environment resources
are disposed when switching views or unmounting the editor.

Controls and labels sit outside the WebGL viewport, which uses the available
workspace instead of a small fixed-aspect card. Model progress starts with layers
and paint tools out of the way. Show/Hide layers is a real toggle; dismissing the
shell panel no longer recreates its layer list over the model. A closed layer list
also hides the empty context panel within Design Studio only.

In the separate draft 3D preview, removing the last applicable paint layer now
restores the imported neutral material colour and refreshes the material shader.
The progress model remains the sample livery, not a live draft-paint compositor.

Regression coverage includes draft preservation, panel dismissal and reopening,
neutral material restoration, and a 430px-wide enforced-CSP browser review with
controls outside the model viewport. No new geometry or asset admission is
included in this viewer quality pass.
