# World renderer

M7-01 establishes the browser rendering boundary described by App. H.2. It is a single
deck.gl instance with two views over one layer list:

- `MapView` provides the repeating flat world.
- deck.gl's experimental `_GlobeView` provides the three-dimensional world.
- `packages/web/src/world/layers.ts` is the only layer factory. A projection switch changes
  the view, not the data, route implementation, terminator, or layer-toggle state.

The renderer lives behind the player shell in `WorldRenderer.tsx`. It is a visual client:
it may present server-owned state but must not calculate demand, economics, flight outcomes,
or other authoritative game state.

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
declination/equation-of-time equations. It generates longitude/latitude cells and assigns a
continuous darkness value across civil twilight, rather than drawing a hard half-world line.
The mesh updates once per minute. Full quality uses 5-degree cells; reduced quality uses
10-degree cells.

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
- antimeridian great-circle layer configuration;
- equinox/solstice terminator behavior and mesh resolution;
- idle, recovery, sustained-low-FPS, and manual-reset behavior;
- palette-token parsing and renderer failure fallback.

For renderer changes, also run the real client build and inspect `/world` in a WebGL-capable
browser at desktop and mobile widths. Confirm both projections render, controls remain above
the canvas, drag/zoom/double-click work, theme switching changes the palette, and the browser
console contains no deck.gl or WebGL errors. Frame-rate claims must be measured in a real
browser; jsdom tests prove policy, not GPU performance.

## Known upstream constraint

deck.gl 9.3 exposes GlobeView as `_GlobeView` and documents it as experimental. It is suited
to the whole-world overview in M7-01, but not to street-level zoom, pitch, or bearing. Keep the
view construction isolated in `WorldRenderer.tsx` so an upstream API change does not fork the
layer or data contracts.
