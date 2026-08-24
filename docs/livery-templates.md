# Aircraft livery templates (M6-02)

Tailfin's legacy livery templates are versioned, plain SVG assets under
`packages/shared/assets/livery/templates/v1`. Every launch-catalogue aircraft family has a
side-profile asset and a top-down asset. Both projections use the same `1200 × 400`
coordinate system and the same zone contract, so a single M6-01 `LiveryDocument` can be
projected onto either compatibility view without rewriting its layers. They are retained for
`legacy_svg` documents; v2 `uv3d` documents instead resolve exact versioned model, UV, material
and anchor resources.

## Asset contract

Each SVG root declares:

- `viewBox="0 0 1200 400"`;
- `data-template-version="v1"`;
- `data-aircraft-family`, matching the catalogue's family string;
- `data-projection`, either `side` or `top`.

The asset contains one group for each livery zone. A group's SVG id is `zone-<zone id>`, its
`data-livery-zone` value is the exact M6-01 zone id, and `data-zone-viewbox="x y width height"`
maps normalized document coordinates into that zone. Geometry outside the normalized zone
extent is clipped by the consuming renderer. Some projection-inapplicable regions, such as
door surrounds in the top-down view, retain an invisible geometry target: the structural
target stays identical while that projection correctly paints nothing.

The required zone identifiers are:

1. `fuselage`
2. `nose`
3. `belly`
4. `tail_fin`
5. `winglets`
6. `engine_nacelles`
7. `wings`
8. `cheatline_band`
9. `door_surrounds`
10. `registration_area`

Assets contain only SVG geometry and presentation attributes. Scripts, embedded raster
images, external resources and house liveries are deliberately excluded. This keeps the
same source usable by the browser builder and retained SVG fallback renderer.

## Family coverage

The 13 launch families are `ATR 72`, `Dash 8`, `E-Jet E2`, `A220`, `737NG`, `737 MAX`,
`A320neo`, `787`, `A350`, `777`, `777X`, `A380` and `747`. The file names use stable
lowercase slugs, for example `a320neo-side.svg` and `a320neo-top.svg`.

`packages/web/src/livery/templates.ts` is the browser asset registry. It keeps catalogue
order, resolves a family/projection pair to its bundled URL, and is the seam consumed by the
M6-03 builder. Server-side consumers should read these same shared source assets rather than
copying them into another package.

## Verification boundary

`packages/web/src/livery/templates.test.ts` derives the expected families from the aircraft
catalogue and verifies all 26 assets. It checks safe plain SVG structure, root metadata,
identical zone identifiers, positive zone coordinate maps, registry coverage and that one
valid M6-01 document resolves every layer in both projections of every family.

M6-02 supplies compatibility templates, not the true-3D asset manifest. M6-03 applies fill and
gradient layers in the browser builder. The M6 true-3D epic (#716) owns the versioned asset
manifest, UV-aware renderer, richer authoring, publication and airframe application.
