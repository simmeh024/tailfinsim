# World renderer

M7-01 establishes the browser rendering boundary described by App. H.2. It is a single
deck.gl instance with two views over one layer list:

- `MapView` provides the repeating flat world.
- deck.gl's experimental `_GlobeView` provides the three-dimensional world.
- `packages/web/src/world/layers.ts` is the only layer factory. A projection switch changes
  the view, not the data, route implementation, terminator, or layer-toggle state.

The renderer is a visual client: it may present server-owned state but must not calculate
demand, economics, flight outcomes, or other authoritative game state.

## It is the World page, not a backdrop

App. H.4 describes the world as permanently visible behind every screen, and the shell was
built that way — the renderer mounted in the shell, with `<Outlet />` drawn over it in the
same grid area. That read as the doc's intent and behaved nothing like it:

- **an ordinary page is opaque.** A fleet table covered the world completely, so what was
  behind it was not a backdrop, it was a hidden layer costing a WebGL context and its frames
  on screens that never showed a map;
- **the map could not be driven from anywhere but the World route**, because the page content
  above it took every pointer event aimed at the canvas;
- **the world was never seen at full size**, which is the one thing §1's _"come back the next
  morning to see where your aircraft ended up"_ needs.

So `WorldPage` owns the renderer and every other route gets the plain inset background. The
shell's middle grid area is named `stage` rather than `world` for that reason, and it scrolls
— the backdrop it replaced was `overflow: hidden`, which had been silently clipping every
page taller than the viewport.

A shared backdrop can return if it is ever built as one: translucent page surfaces, pointer
events reaching through, and a decision about which routes want it. That is a design change,
not the accident this was.

## Projection and camera contract

The stored key is `tailfin.world.projection`, with `flat` and `globe` as its only valid
values. A saved choice always wins. On first use:

- narrow or coarse-pointer devices start flat;
- devices reporting at most 4 GiB of memory or at most four logical processors start flat
  and use reduced detail;
- other desktops start on the globe.

Storage reads and writes are guarded because browser policy and private modes can reject
local storage. Failure to persist must never prevent the world from rendering.

Both views use the same controlled longitude, latitude and zoom. Drag pans, scroll or pinch
zooms, and double click/tap focuses. Switching projection preserves that camera state and all
layer toggles. Pitch and bearing remain zero because deck.gl's globe does not support them;
latitude and zoom are clamped to the range both views can represent.

### A stored view state describes the camera and nothing else

`onViewStateChange` does not hand back three numbers. It hands back the controller's fully
resolved internal state — `width`, `height`, `altitude`, `position`, `normalize`, `maxBounds`
and the pitch limits alongside the camera — and storing that verbatim was a bug.

`width` and `height` were the cause. They are the canvas dimensions **as deck.gl saw them
when the first event fired**, which in practice was `300 x 150`: the default size of a
`<canvas>` that has not been measured yet. Fed back as a controlled prop, they make the
application authoritative about viewport geometry, so every subsequent pan delta is converted
against a window the pointer is not moving in. The map lurches and settles somewhere other
than where it was dragged.

`clampViewState` therefore **picks** the seven fields the application owns and drops the rest.
The size of the canvas is deck.gl's business, and it is the one thing a controlled view state
must never claim to know. `camera.test.ts` enumerates the surviving keys rather than
snapshotting them, so a deck.gl upgrade that adds a field fails the test instead of smuggling
it back into application state.

Longitude is left alone. `MapView` is configured `repeat: true`, so panning past the
antimeridian is meant to keep counting; re-normalising it on every event fought the
controller's own bookkeeping mid-gesture.

The visual projection change is a 180 ms CSS transition. Reduced-motion users inherit the
global zero-duration motion tokens.

## Layers

The baseline layers are:

1. ocean polygon;
2. Natural Earth land from the bundled `world-atlas` 110 m TopoJSON asset;
3. optional graticule;
4. optional day/night shading;
5. optional routes.

No basemap or tile service is contacted at runtime. This keeps the first renderer usable
without an API key or a third-party availability dependency.

Routes are `ArcLayer` instances with `greatCircle: true`. That one implementation is used in
both projections. In flat mode deck.gl splits/wraps the great-circle arc at the antimeridian;
do not pre-flatten or manually splice routes for `MapView`. Reduced detail halves the arc
tessellation from 100 to 50 segments.

M7-01 intentionally supplies no invented airline or aircraft data. The renderer accepts
typed `WorldRoute` input, but the shell passes an empty list until M7-02 supplies live,
server-owned aircraft and operational-route state.

## Day and night

`terminator.ts` derives the subsolar point from UTC time with the compact NOAA solar
declination/equation-of-time equations, and `darknessAt` gives a continuous night opacity
across civil twilight rather than a hard half-world line.

### A sampled field, not a mesh

The shading was originally a `SolidPolygonLayer` of 5-degree cells, each flat-filled with the
darkness at its centre — 2,592 quads at full quality. Flat-filling is what made **the night
line a visible staircase**: the boundary could only ever be as smooth as the cell edges.

It is now a `BitmapLayer` over the whole sphere, whose image is a darkness field sampled once
a minute — `512 x 256` at full quality, `256 x 128` reduced — uploaded as an RGBA texture in
the palette's night colour and filtered `linear`. The GPU's bilinear interpolation is what
produces the gradient, so the terminator is a smooth curve at any zoom, from one quad instead
of thousands.

Two details are load-bearing:

- **A field rather than geometry.** The terminator has no singularity-free parametrisation: at
  an equinox the curve is a pair of meridians rather than a function of longitude, so any
  "latitude per longitude" mesh degenerates there. Sampling needs no parametrisation at all.
- **Row 0 is the north pole**, because `BitmapLayer` maps an image's top edge to the northern
  bound. Reversing it swaps day and night, which looks like a palette bug and is not one, so
  `terminator.test.ts` asserts the row order against a solstice.

The field is generated palette-free and coloured in `layers.ts`, so a theme change re-colours
the night without recomputing any astronomy.

### The pairing the contrast tests were missing

Every ratio in the table above compares two _things_: land against sea, a coastline against its
land, a route against the water it crosses. **None of them asks whether night is
distinguishable from day on the same surface** — and that is the question a terminator is.

It was measured on the deployed build with a scanline across the globe:

| surface | daylight      | night        | ratio    |
| ------- | ------------- | ------------ | -------- |
| land    | `119,153,176` | `81,108,130` | 1.83     |
| sea     | `13,32,56`    | `12,30,52`   | **1.02** |

Two units per channel. The terminator was rendering correctly and perfectly — the twilight
gradient was there in the scanline, `90,119,141` and `74,101,121` on the way down — and it was
invisible on the two-thirds of the globe that is water. It looked like a broken shading layer
and was a palette that had never been asked the right question.

Fixing it needed a **lighter sea**, because there is no room to darken something already
near-black, and a stronger night wash. `palette.test.ts` now asserts the dimming on both
surfaces, so a retune cannot lose the terminator again.

## The palette has a measurable bar

App. H.7 asks for **"WCAG AA contrast throughout"**, and the world is nothing but graphical
objects sitting on each other: land on ocean, a coastline on its own land, a route across the
sea it crosses. AA's threshold for a meaningful graphic is **3:1**. The original palette was
nowhere near it:

| pairing                      | before     | after  | AA  |
| ---------------------------- | ---------- | ------ | --- |
| dark: land vs ocean, day     | **1.49**:1 | 5.44:1 | 3:1 |
| dark: land vs ocean, night   | **1.19**:1 | 3.05:1 | 3:1 |
| dark: coastline vs land, day | **2.48**:1 | 5.59:1 | 3:1 |
| light: land vs ocean, day    | **1.41**:1 | 4.94:1 | 3:1 |

The map was a very dark object with a slightly-less-dark object drawn on it, which is why it
read as unlit even in daylight. Two changes fixed it together, because they interact: the base
colours moved (a navy sea with legibly lighter land, in both themes) and the night alpha came
down from `215` — 84% of a near-black — to `90`.

`palette.test.ts` measures every pairing in **both themes, in daylight and under full night**,
and asserts the _composited_ result rather than the alpha, because the alpha is not the thing
that matters.

The alphas themselves live in `tokens.css`, as eight-digit hex beside the colour. They used to
be constants in `palette.ts`, and that split is what hid the terminator bug: the dark theme
wants a strong night wash and the light theme a much weaker one, and with the opacity nowhere
near the theme it was never obvious it had to vary with it. It also asserts that night still reads as night: the dimming has a floor as well
as a ceiling, since shading nobody can see is not shading.

The graticule is the one world layer the contrast tests do not gate. One flat overlay at 31%
cannot contrast strongly with both a dark sea and a light landmass; its colour favours the
ocean, where most of a meridian runs, and it is toggleable.

### An unwrapped ring has to be recentred, or the flat map loses a continent

Unwrapping starts its carry at zero on the ring's **first** vertex, so where a ring happens to
begin decides where the whole ring ends up. Afro-Eurasia's outline starts just west of the
antimeridian in Chukotka: the second vertex is 358 degrees east of the first, the carry takes
−360, and the entire landmass came out spanning **−377.6 to −169.9** instead of −17.6 to 190.1.

Contiguous, no jumps, and it passes a jump test — it is simply a whole world to the west. The
globe did not care, because a sphere is periodic. The flat map had **no Africa, no Europe and
no Asia on it**, plus a pale sliver of the displaced ring cutting diagonally across the
Atlantic that looked for all the world like a broken day/night terminator.

So each ring is shifted back by whole worlds until its own midpoint lies inside [−180, 180].
Every vertex moves by the same multiple of 360, so contiguity is untouched. The bound is
**strict**: a ring that legitimately straddles the antimeridian sits at 179..181 with a
midpoint of exactly 180 and must stay there, and Antarctica spans −180..180 with a midpoint of
0 and never moves. Rounding to the nearest world instead of clamping to the range puts the
straddling rings back where they started.

`land.test.ts` asserts every ring's midpoint in **both** tiers is in range, which is the
invariant that was violated, rather than only the jump property that was not.

### Coastlines come in two resolutions, and the finer one is loaded on demand

`land-110m` is 1:110,000,000 — about a degree between vertices. At whole-globe zoom it is
indistinguishable from finer data and costs 54 KB. Zoomed in it is unmistakable: the
Mediterranean becomes a row of straight multi-degree segments, and no amount of mesh
refinement or filtering helps, because the _data_ has no more shape in it.

`land-50m` is a little over twice as detailed and **ten times the bytes** — 533 KB, roughly a
third of the whole client bundle, for something most sessions never zoom in far enough to see.
So it is a dynamic `import()`: Vite emits it as its own chunk, and `loadDetailedLand` fetches
it once, the first time the camera passes `LAND_DETAIL_ZOOM`.

Measured on a build and a real session:

|                  |                       size | when                                  |
| ---------------- | -------------------------: | ------------------------------------- |
| main bundle      | 1,291 KB / **376 KB gzip** | first paint (was 372 KB gzip)         |
| `land-50m` chunk |   546 KB / **179 KB gzip** | only after zooming past the threshold |

The resource timeline shows `land-110m` at 107 ms and `land-50m` at 15.4 s, when the camera
first went in.

This does not weaken §21's _"no basemap or tile service is contacted at runtime"_: the chunk is
served from the same origin as the app, with no API key and no third-party availability in the
path. A failed fetch resolves to the coarse outline rather than rejecting — losing detail is
acceptable, losing the world view is not.

`land-10m` exists and is 3 MB. That is a tile service's job, not a bundle's.

### The land data has to be unwrapped across the antimeridian

`land-110m` stores longitudes in `[-180, 180]`, so a coastline crossing the antimeridian has
two consecutive vertices like `179.99` and `-180`. Neighbours on a sphere; **360 degrees apart
in the coordinate space the layers tessellate in.** The coastline `PathLayer` drew that as a
segment sweeping the entire way round the world, which on the globe appears as a large smooth
arc across the Arctic with no coastline under it.

There are seven such jumps in the dataset: Eurasia twice at Chukotka (65N, 69N), Wrangel
Island, Fiji twice, and Antarctica. The northern three are why the artefact shows around the
North Pole.

`unwrapAntimeridian` in `land.ts` carries a multiple of 360 along each ring so no step exceeds
180 degrees, and both tiers go through it.
A ring may then legitimately run past 180 — `179.99, 180.01` rather than `179.99, -179.99` —
which is the same point on a sphere, and on the flat map `repeat: true` already draws the
neighbouring world copy. `land.test.ts` asserts no ring jumps, in either tier.

`wrapLongitude` on the layer does **not** fix this, which was worth finding out by trying it:
it shifts whole paths for Web Mercator and leaves the jump inside the ring untouched.

Isolating it took toggling one layer at a time on the live page — the arc survived hiding the
atmosphere, the graticule and the day/night layer, and vanished with the land layer. Then
`filled: false` showed it was in the stroke rather than the fill.

### Twilight spans the real elevations

Full daylight above **+6 degrees** of solar elevation, full night below **-18** — astronomical
twilight, where the sky is genuinely dark. The band was originally +3 to -9: twelve degrees,
narrow enough that the edge read as a line rather than as dusk, and both numbers invented.

The band is deliberately **asymmetric about the geometric terminator**, because the sky is.
At elevation 0 — sunset — the shading is only about 16% of full night, and the _perceived_
edge lands near -6, the end of civil twilight, which is where it actually gets dark.

### The atmosphere ring is only for a whole globe

`.world-renderer__atmosphere` is a CSS ellipse inset 5% of the container, with a radial glow.
It knows nothing about where the globe is, which is fine while the planet sits small and
centred — that is what makes it read as a planet in space.

Zoom in far enough that the sphere overflows the frame and the ring tracks nothing: it becomes
a bright arc laid across the map, most obviously over a pole. So it is gated on
`data-atmosphere`, set from the camera's zoom against `ATMOSPHERE_MAX_ZOOM`.

### The globe's mesh resolution is the terminator's edge quality

`GlobeView`'s `resolution` is degrees per mesh vertex, and it decides more than geometry
smoothness. The night field is a **texture**, and `BitmapLayer` interpolates texture
coordinates across each flat facet of that mesh — so the mesh is the finest the shading can
possibly be.

At five degrees the facets are large enough that a diagonal terminator breaks into a visible
staircase of five-degree steps. The field is smooth, the filtering is linear, the texture is
512x256 — none of that matters, because the mesh cannot express a curve finer than its own
cells. Toggling **Day/night** off makes the staircase vanish while the coarse `110m`
coastlines stay, which is how the two were told apart.

Full quality is now `2`, roughly six times the triangles for a boundary that reads as a curve;
reduced stays at `5`. The land and route geometry are tessellated by the same number, so
coastlines gain from it too.

### One `bounds` array per mesh shape, and why that is not a micro-optimisation

The world-sized layers — the ocean fill and the night texture — are `BitmapLayer`s covering
`[-180, -90, 180, 90]`. Each **projection and quality tier** gets its own array instance of
those same four numbers, which looks like pointless duplication and is the opposite.

`BitmapLayer.updateState` rebuilds its mesh only when `props.bounds` changes by **reference**,
and `createMesh` tessellates according to the viewport's `resolution`: absent on `MapView`, so
a flat two-triangle quad; five degrees on `GlobeView`, so a mesh that follows the sphere.
Hand both views one frozen module constant and the quad built for the flat map survives the
switch — two triangles cutting straight through the planet, ending up inside it and occluded by
`GlobeView`'s own opaque backdrop.

The symptom is a **black globe with land floating on it**: continents are drawn from real
multi-vertex coastlines and tessellate on their own, so they appear, while the sea and the
day/night shading do not appear at all. Measured on the globe, the meshes go from 2 triangles
to 5,184 once each view has its own bounds.

This is also why `projection` is a dependency of the layer `useMemo` in `WorldRenderer` even
though the layer _list_ is identical for both views: switching projection has to rebuild the
layers for the meshes to re-tessellate.

### `image` must be an `ImageData`, or the texture arrives empty

**This is what actually made the world black**, and it is the failure worth reading first
because every cheap diagnostic said the layer was fine.

`BitmapLayer` accepts `image` as an object. Handed `{ data: Uint8Array, width, height }` it
builds a texture of **exactly the right dimensions containing nothing at all**. The size is
read off the object; the pixels are never uploaded. So:

| what a diagnostic reported |                                     |
| -------------------------- | ----------------------------------- |
| mesh built                 | yes, 5,184 triangles on the globe   |
| model present              | yes                                 |
| texture                    | `Texture(rgba8unorm, 512x256)`      |
| **texture contents**       | **0 non-zero bytes out of 524,288** |

Only the last line is the truth, and only a readback finds it:

```js
const bytes = texture.readDataSyncWebGL(); // all zeros == nothing was uploaded
```

`ImageData` is a real image source, so deck.gl uploads it — and it needs no 2D canvas context,
which matters because jsdom has neither. Both world bitmaps build one. After the change the
same readback returns `[13, 32, 56, 255]` for the ocean, the palette's navy at full alpha.

jsdom ships without `ImageData`, so `test-setup.ts` defines a data-only stand-in. That is not
test convenience: the _shape_ is load-bearing in production, so the tests have to be able to
construct it.

### A data texture must not be left on a mipmapping filter

A second, independent way the same texture renders black — real, and it would have bitten the
moment the upload was fixed.

luma.gl's default sampler is `minFilter: linear, mipmapFilter: linear`, which
`convertMinFilterMode` turns into WebGL's `LINEAR_MIPMAP_LINEAR`. A texture uploaded from a
typed array has a single mip level and no mipmap chain, so that filter makes it an
**incomplete texture** — and an incomplete texture samples as **opaque black**, silently, with
no warning and no GL error.

Setting `minFilter: 'linear'` alone does not fix it. The mipmap half of the pair comes from
the default and stays; the two are combined, not overridden. Both world bitmaps share
`DATA_TEXTURE_SAMPLER`, which sets `mipmapFilter: 'none'` explicitly.

Measured on the live texture, the WebGL minification filter goes from `LINEAR_MIPMAP_LINEAR`
(`0x2703`) to `LINEAR` (`0x2601`). That is the check worth repeating if a texture-backed layer
ever renders as a flat black shape:

```js
gl.bindTexture(gl.TEXTURE_2D, texture.handle);
gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER); // 9729 LINEAR is complete
```

It also explains the shape of the hunt. A black sea is indistinguishable from a missing sea,
so the same symptom survived a palette retune, a tessellation fix and a culling fix — each of
which was a genuine defect, and none of which was this one.

### A full-sphere quad must not be back-face culled

The other half of the black globe, and the harder half to see.

A world-sized quad wraps the entire sphere, so its near and far halves have **opposite
apparent winding** once projected. `cullMode: 'back'` discards one of them — and when that is
the near one, all that remains sits behind `GlobeView`'s own opaque backdrop and is rejected
by the depth test. Nothing reaches the screen.

The layers that kept rendering on the globe throughout were exactly the ones already using
`cullMode: 'none'`: the graticule and the routes. The ocean and the night texture used
`'back'`, and neither appeared.

Culling buys nothing here in any case. There is one quad per layer, the depth buffer already
hides the far side, and the cost of drawing it is a few thousand fragments that fail the depth
test. Both world-sized bitmaps now use `none`, and `layers.test.ts` asserts it.

### The bitmap mesh has to track the viewport, not just the bounds

Giving each projection its own `bounds` instance makes `BitmapLayer` rebuild its mesh, and it
is **not sufficient**. `createMesh(bounds, viewport.resolution)` reads the resolution off
whatever viewport is in context at that moment, and on a projection switch the view and the
layers change in the same React render — deck.gl updates layers **before** it activates the new
viewport. So switching flat to globe built the flat map's two-triangle quad and kept it.

On a sphere those two triangles are a chord straight through the planet, occluded by
`GlobeView`'s own backdrop: the ocean and the day/night shading both render black while the
land, the graticule and the routes carry on drawing normally. Measured on the deployed build
immediately after switching flat to globe — viewport `resolution: 2`, `bounds` correct at
±90, and a mesh of **six indices**.

A fresh page load never hits it, because there the globe's viewport is in context from the
first update. That is why it survived being looked at repeatedly: every check started with a
reload.

`WorldBitmapLayer` records the resolution its mesh was actually built at, opts in to viewport
changes through `shouldUpdateState` (a stock `BitmapLayer` ignores them), and on any update
where the viewport disagrees presents the base class with a changed `bounds` so it takes its
own rebuilding branch. `layers.test.ts` asserts both world-sized bitmaps use it and that a
viewport-only change is enough to update them — and that test fails against a stock
`BitmapLayer`, which was checked by reverting it rather than assumed.

### The night field's rows are generated per projection, and deck.gl converts nothing

`BitmapLayer` interpolates texture coordinates linearly in whatever coordinate system the
viewport uses. On the globe that is lng/lat. On the **flat map it is Web Mercator**, which
stretches towards the poles — so a field sampled at equal degrees of latitude per row has its
night boundary drifting from the true latitude, further the closer to the poles.

deck.gl's own answer is `_imageCoordinateSystem: 'lnglat'`, which converts in the shader. That
was here, and it is observable that it engages: on `MapView` the layer's `coordinateConversion`
becomes `-1`, `0` on `GlobeView`. **It does not survive a world-sized quad.** Measured on the
deployed build:

- on the **flat map**, with `bounds: [-180, -90, 180, 90]`, the entire field was squashed into a
  tapering horizontal wedge across the equator — the day lens compressed into a band a few
  degrees tall, everything else full night;
- on the **globe**, hard-edged rectangular blocks of full night over land that was in daylight.
  A scanline across the Mediterranean read alpha `0` for most land and `120` — the palette's
  full night — in isolated blocks, with no intermediate values between them.

The root of it is that Web Mercator has no latitude ±90: `y` runs to infinity there, so a flat
quad cannot be given the poles in the first place. So the fix is on both sides at once, and the
two halves have to agree:

|          | `worldBounds` north                       | `createDarknessField` spacing             |
| -------- | ----------------------------------------- | ----------------------------------------- |
| globe    | `90`                                      | `equirectangular` — equal degrees per row |
| flat map | `85.051129` (`WEB_MERCATOR_MAX_LATITUDE`) | `mercator` — equal mercator units per row |

The mapping is then exactly linear in each viewport and there is nothing to convert;
`_imageCoordinateSystem` is left at `'default'`, and `layers.test.ts` asserts that value rather
than merely "not lnglat", because any other value re-enters the shader path. `DarknessField`
carries its own `northLatitude` so the two cannot silently drift apart, and
`terminator.test.ts` reconstructs the latitude each mercator row is drawn at from the
projection and requires the field's value there to match.

The ocean bitmap takes the same bounds, which is free: a single-colour fill samples the same
whatever the coordinates mean, and ±85.051129 already covers the whole renderable sheet.

### Renaming a grid area renames it everywhere, including inside a media query

`world` became `stage` in the shell's base grid when the renderer moved to its own page, and
one `@media (max-width: 48rem)` block kept the old name. A `grid-template-areas` naming an
area no element claims places nothing: `grid-area: stage` matched no area, the stage was
auto-placed, and below 48rem it collapsed to **24 pixels** — the whole page reduced to a dot,
not just the world.

Desktop widths never reach that block, so nothing caught it until a browser pane happened to
be 316 pixels wide. `AppShell.test.tsx` now parses `shell.css` and asserts that every area
named in any `grid-template-areas` is one an element actually claims; reintroducing the old
name fails it with `expected [ 'world' ] to deeply equal []`.

### The ocean is a bitmap, not a polygon

It was a `SolidPolygonLayer` holding one six-vertex rectangle, which is exactly right on a flat
map and cannot wrap a sphere — `SolidPolygonLayer` does not subdivide for the globe. That was
invisible while the ocean was `#060f1b`, which is very nearly the same black as `GlobeView`'s
backdrop. Retuning the palette to a legible navy is what exposed it.

### `FALLBACK_PALETTE` is a duplicate, and there is a test for that

`palette.ts` carries the dark theme's colours a second time, for when `getComputedStyle`
returns nothing — which is every jsdom test. That is a drift hole, so `palette.test.ts` parses
`tokens.css` and asserts the two agree. Without it, a retune in one place and not the other is
invisible until the world is rendered somewhere the tokens cannot be read.

### The terminator follows the wall clock, not the world clock

Known, and wrong. `createDarknessField` is called with `new Date()`, so the sun is where it is
_in reality_ — but a Tailfin world runs from its own epoch at its own speed multiplier
(ADR-0005), so its date and time of day are not ours. A world at 2x has days passing twice as
fast and its terminator should sweep twice as fast.

Fixing it needs the world's clock on the client, and no player-facing endpoint carries it:
`/api/fleet/catalogue` returns `inGameDate`, which is a snapshot rather than a clock — there is
no `epoch`, `launchDate` or `speedMultiplier` to advance locally. That is a contract change and
belongs with whichever issue puts live world state on this page (M7-02), not with a shading
fix. luma.gl wants the texture as flat `data` with
`width` and `height` beside it; handed `{ data: { data, width, height } }` it silently
produces a `1 x 1` texture, which renders as one flat wash over the world.

This is display geometry only. It does not advance world time or create gameplay effects.
When server-authoritative world time becomes an input to lighting, pass that timestamp into
the renderer rather than deriving simulation state in the browser.

## Performance policy

The desktop budget at world zoom is 60 frames per second. deck.gl reports one-second metrics
to `SustainedFrameRateMonitor`. The monitor ignores idle samples, because a static globe with
no redraws is not a slow globe. Four consecutive active samples below 50 fps:

- enable reduced device-pixel ratio, globe resolution, terminator resolution, and route
  tessellation;
- show a non-blocking offer to switch to the flat view;
- allow the player to keep the globe and dismiss the offer.

Mobile and low-power first runs begin with reduced detail before a slow-frame streak. A
projection change resets the streak. Renderer errors produce an accessible warning while the
rest of the shell stays usable.

## Verification

Unit coverage owns deterministic policy and geometry:

- first-run and saved projection selection;
- camera and toggle preservation across projection changes;
- the fields a stored view state may and may not carry (`camera.test.ts`);
- the renderer being present on `/world` and absent elsewhere;
- antimeridian great-circle layer configuration;
- equinox/solstice terminator behaviour, field row order, and gradient continuity;
- idle, recovery, sustained-low-FPS, and manual-reset behavior;
- palette-token parsing and renderer failure fallback.

For renderer changes, also run the real client build and inspect `/world` in a WebGL-capable
browser at desktop and mobile widths. Confirm both projections render, controls remain above
the canvas, drag/zoom/double-click work, theme switching changes the palette, and the browser
console contains no deck.gl or WebGL errors. Frame-rate claims must be measured in a real
browser; jsdom tests prove policy, not GPU performance.

**A headless browser is not enough for pointer behaviour.** deck.gl drives its controller and
its canvas sizing from the animation loop, so in a pane that is not compositing there are no
frames: the canvas keeps its default `300 x 150` backing store, synthetic pointer events reach
`mjolnir.js` and produce no pan, and layers are never instantiated until
`layerManager.updateLayers()` is called by hand. That environment can still prove a great deal
— what a layer builds, what a texture's real dimensions are, what the controlled loop stores —
but a claim that dragging works has to come from a real window.

## Known upstream constraint

deck.gl 9.3 exposes GlobeView as `_GlobeView` and documents it as experimental. It is suited
to the whole-world overview in M7-01, but not to street-level zoom, pitch, or bearing. Keep the
view construction isolated in `WorldRenderer.tsx` so an upstream API change does not fork the
layer or data contracts.
