# Livery builder: 3D preview, paint map, layers and base fills (M6-03)

The Design route now hosts Tailfin's livery editor. It consumes the M6-01 `LiveryDocument`
contract and the exact M6-02 SVG template sources; it does not maintain a second browser-only
paint format or recreate aircraft geometry in React.

## Editor surface

The aircraft remains the visual centre of the page. The default **3D preview** reuses the same
1440px three-quarter aircraft renders as the fleet catalogue. Each authoring family maps to a
representative catalogue type, and an SVG luminance-threshold mask projects the document's
visible paint layers over the lit airframe. Normal paint uses colour blending against the fleet
render rather than an isolated flat coat, preserving windows, panel lines, engine detail,
highlights and specular lighting. New base fills start at 72% opacity so the first result retains
material depth while leaving 100% available deliberately.

Zone placement in this view is illustrative because the catalogue render is perspective
imagery. Broad body regions share one projection; all 13 authoring families register their own
visible wing, winglet and nacelle shapes against the selected fleet asset. Body paint is
composited behind those physical surfaces, so an unpainted wing or engine retains the original
material even where the perspective overlaps the fuselage. The **Paint map** switch shows the
exact side-profile zone clipping and remains the canonical authoring view.

On wide screens the collapsible base-fill rail sits beside the canvas and the shell context
window owns the layer stack. At compact desktop and mobile widths the tools start collapsed; on
mobile they open over the canvas while the shell context window becomes its existing bottom
sheet. The result keeps colour changes and light layer edits usable on touch screens without
pretending deep vector work is comfortable there.

M6-03 authors four base-fill modes:

- solid;
- linear gradient;
- radial gradient;
- split, represented as a near-hard four-stop linear gradient because M6-01 deliberately
  requires strictly increasing stop offsets.

Every fill targets one of the ten shared livery zones. The browser renderer parses a trusted
plain SVG source, clones only the selected zone geometry for each visible paint layer, and adds
solid or gradient paint in canonical document order. Opacity and SVG blend mode are applied to
the cloned layer. This means changing the family changes geometry, not the livery document.

The colour controls provide the platform picker, canonical HEX entry, individual RGB channels,
a document-backed 16-colour brand palette and the browser EyeDropper API where supported. A
cancelled or unsupported eyedropper leaves the document unchanged and reports that outcome in
the tool rail.

## History and autosave

All document changes flow through one immutable `past / present / future` reducer. Add, remove,
rename, hide, lock, opacity, blend mode, reorder, fill mode, fill colours, split position,
palette changes and preview-family changes all clear redo and enter the same bounded 100-step
history. `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y` use that reducer too.

M6-03 has no server livery table or save endpoint. A draft is therefore autosaved after every
committed state change to an airline-scoped browser key:

`tailfin:livery-draft:v1:<airline id>`

The envelope stores its own draft version, selected preview family and the canonical
`LiveryDocument`. Loading validates the family against the template registry and parses the
document through the shared Zod schema. Invalid, corrupt or newer local data is ignored in
favour of a valid starter document. Storage failure is visible as `Autosave unavailable`; there
is intentionally no Save button.

This is local durability, not a claim of server persistence. M6-04 and M6-05 add the remaining
authoring tools, M6-06 adds authoritative raster output, and M6-07 owns server persistence and
airframe application.

## Verification

The M6-03 tests cover history for every mutation including reorder, redo invalidation, history
limits, storage round-trips and corruption, HEX/RGB conversion, all four render modes, hidden
layers, paint order, every launch-family side template, every fleet-preview family mapping and a
full UI remount from autosave. A 30-layer benchmark performs repeated schema-valid mutations and
asserts average reducer cost stays under one 60 fps frame.
