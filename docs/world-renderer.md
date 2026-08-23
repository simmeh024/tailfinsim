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
that matters. It also asserts that night still reads as night: the dimming has a floor as well
as a ceiling, since shading nobody can see is not shading.

The graticule is the one world layer the contrast tests do not gate. One flat overlay at 31%
cannot contrast strongly with both a dark sea and a light landmass; its colour favours the
ocean, where most of a meridian runs, and it is toggleable.

### One `bounds` array per projection, and why that is not a micro-optimisation

The world-sized layers — the ocean fill and the night texture — are `BitmapLayer`s covering
`[-180, -90, 180, 90]`. Each projection gets its **own array instance** of those same four
numbers, which looks like pointless duplication and is the opposite.

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

### The night field is equirectangular, and deck.gl has to be told

`BitmapLayer` interpolates texture coordinates in whatever coordinate system the viewport
uses unless `_imageCoordinateSystem` says otherwise. On the globe that is already lng/lat. On
the **flat map it is Web Mercator**, which stretches towards the poles — so a field sampled at
equal degrees of latitude per row had its night boundary drifting from the true latitude,
further the closer to the poles.

Declaring `_imageCoordinateSystem: 'lnglat'` makes deck.gl convert on the way in. It is
observable: on `MapView` the layer's `coordinateConversion` becomes `-1`, and on `GlobeView` it
stays `0` because no conversion is needed. The ocean does not declare it — a single-colour fill
samples the same whatever the coordinates mean.

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
