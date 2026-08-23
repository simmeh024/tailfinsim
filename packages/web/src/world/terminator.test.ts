import { describe, expect, it } from 'vitest';

import {
  createDarknessField,
  darknessAt,
  subsolarPoint,
  WEB_MERCATOR_MAX_LATITUDE,
} from './terminator';

describe('day/night terminator geometry', () => {
  it('puts the equinox subsolar point near the equator and the noon meridian', () => {
    const sun = subsolarPoint(new Date('2026-03-20T12:00:00.000Z'));
    expect(Math.abs(sun.latitude)).toBeLessThan(1);
    // Equation-of-time means solar noon is a few degrees away from Greenwich.
    expect(Math.abs(sun.longitude)).toBeLessThan(4);
  });

  it('tracks the northern and southern solstices', () => {
    expect(subsolarPoint(new Date('2026-06-21T12:00:00.000Z')).latitude).toBeCloseTo(23.45, 0);
    expect(subsolarPoint(new Date('2026-12-21T12:00:00.000Z')).latitude).toBeCloseTo(-23.45, 0);
  });

  it('makes the subsolar side daylight and the antipode night', () => {
    const sun = subsolarPoint(new Date('2026-08-22T12:00:00.000Z'));
    expect(darknessAt(sun.longitude, sun.latitude, sun)).toBe(0);
    expect(darknessAt(sun.longitude + 180, -sun.latitude, sun)).toBe(1);
  });

  it('samples a full field at both qualities', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    const full = createDarknessField(now, 512, 256);
    const reduced = createDarknessField(now, 256, 128);
    expect(full.alpha).toHaveLength(512 * 256);
    expect(reduced.alpha).toHaveLength(256 * 128);
  });

  it('refuses a field too small to interpolate', () => {
    expect(() => createDarknessField(new Date(), 1, 64)).toThrow(/at least 2/);
    expect(() => createDarknessField(new Date(), 64.5, 64)).toThrow(/integer/);
  });

  it('puts the north pole in row zero', () => {
    // The row order is not a detail: `BitmapLayer` maps an image's top edge to the
    // northern bound, so getting it backwards swaps day and night — which looks
    // like a palette bug and is not one.
    const northernSummer = createDarknessField(new Date('2026-06-21T12:00:00.000Z'), 8, 8);
    const southernSummer = createDarknessField(new Date('2026-12-21T12:00:00.000Z'), 8, 8);
    const topRow = (field: { alpha: Uint8Array; width: number }) => [
      ...field.alpha.slice(0, field.width),
    ];

    // Midsummer above the Arctic circle: lit all the way round.
    expect(topRow(northernSummer).every((alpha) => alpha === 0)).toBe(true);
    // Midwinter: dark all the way round — though not *pitch* dark. Row zero samples
    // 78.75N, where the midwinter sun sits about twelve degrees down: nautical
    // twilight, inside the band rather than past it.
    expect(topRow(southernSummer).every((alpha) => alpha > 200)).toBe(true);
  });

  it('spreads twilight across the real elevation band', () => {
    /*
     * With the sun overhead at (0, 0), a point on the equator at longitude L sees
     * the sun at an elevation of `90 - L` degrees. That makes the band directly
     * addressable, which is clearer than picking latitudes and hoping.
     */
    const sun = { longitude: 0, latitude: 0 };
    const atElevation = (degrees: number) => darknessAt(90 - degrees, 0, sun);

    // Full day from +6 up, full night from -18 down: astronomical twilight, not an
    // invented pair of numbers.
    // Exactly on an edge the smoothstep lands a denormal away from its limit, so
    // the boundary itself is checked to tolerance and the interior exactly.
    expect(atElevation(6)).toBeLessThan(1e-9);
    expect(atElevation(20)).toBe(0);
    expect(atElevation(-18)).toBeGreaterThan(1 - 1e-9);
    expect(atElevation(-40)).toBe(1);

    // The geometric terminator — sunset — is still mostly lit, which is what a sky
    // at sunset is. The perceived edge sits later, at civil twilight.
    expect(atElevation(0)).toBeGreaterThan(0.1);
    expect(atElevation(0)).toBeLessThan(0.25);
    expect(atElevation(-6)).toBeGreaterThan(0.4);
    expect(atElevation(-6)).toBeLessThan(0.6);

    // And it only ever gets darker on the way down.
    let previous = -1;
    for (let elevation = 20; elevation >= -30; elevation -= 1) {
      const value = atElevation(elevation);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('produces a gradient rather than a step across the terminator', () => {
    // The complaint the texture replaced a flat-shaded mesh to fix: a night edge
    // built from 5-degree cells of uniform darkness is a staircase. A sampled
    // field has intermediate values, and this asserts there are plenty of them.
    const field = createDarknessField(new Date('2026-08-22T12:00:00.000Z'), 512, 256);
    const partial = [...field.alpha].filter((alpha) => alpha > 4 && alpha < 251);
    expect(partial.length).toBeGreaterThan(2_000);
  });

  it('is deterministic for the same instant', () => {
    const at = new Date('2026-08-22T12:00:00.000Z');
    expect([...createDarknessField(at, 32, 16).alpha]).toEqual([
      ...createDarknessField(at, 32, 16).alpha,
    ]);
  });
});

/**
 * Row spacing (App. H.4).
 *
 * The field is stretched over a quad, so its rows have to be spaced the way the
 * viewport spaces latitude. The globe places a quad's vertices by latitude; the
 * flat map places them in Web Mercator, which stretches towards the poles. A
 * field generated for one and drawn on the other puts the day/night boundary at
 * the wrong latitude — and deck.gl's own `_imageCoordinateSystem: 'lnglat'`,
 * which is supposed to fix that in the shader, produced a tapering wedge on a
 * world-sized quad instead. So the rows are generated to match.
 */
describe('row spacing', () => {
  const noon = new Date('2026-08-22T12:00:00.000Z');

  it('reaches the pole equirectangularly and the mercator limit otherwise', () => {
    expect(createDarknessField(noon, 8, 8).northLatitude).toBe(90);
    expect(createDarknessField(noon, 8, 8, 'mercator').northLatitude).toBe(
      WEB_MERCATOR_MAX_LATITUDE,
    );
    // The default is the globe's, because that is the view the app opens in.
    expect(createDarknessField(noon, 8, 8).alpha).toEqual(
      createDarknessField(noon, 8, 8, 'equirectangular').alpha,
    );
  });

  it('samples a mercator field where the flat map actually draws each row', () => {
    /*
     * The check that would have caught the wedge. Reconstruct the latitude each
     * row is drawn at from the projection itself, and require the field's value
     * there to be the one the row carries.
     *
     * Mid-latitudes are where the two spacings diverge most visibly: row centres
     * around 45 degrees sit roughly 6 degrees apart between the two schemes,
     * which is half a twilight band.
     */
    const height = 64;
    const field = createDarknessField(noon, 128, height, 'mercator');
    const sun = subsolarPoint(noon);
    const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const northY = mercatorY(WEB_MERCATOR_MAX_LATITUDE);

    for (const row of [4, 16, 32, 48, 60]) {
      const y = northY * (1 - (2 * (row + 0.5)) / height);
      const latitude = ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
      const longitude = -180 + (0.5 * 360) / 128;
      expect(field.alpha[row * 128]).toBe(Math.round(255 * darknessAt(longitude, latitude, sun)));
    }
  });

  it('differs from the equirectangular field away from the equator', () => {
    // If this ever passes trivially the two schemes have collapsed into one and
    // the flat map is back to drawing the globe's rows.
    const height = 64;
    const flat = createDarknessField(noon, 128, height, 'mercator');
    const globe = createDarknessField(noon, 128, height);
    expect(flat.alpha).not.toEqual(globe.alpha);
    // ... but they must agree across the middle, where mercator is near-linear.
    const middle = Math.floor(height / 2);
    expect(flat.alpha[middle * 128]).toBe(globe.alpha[middle * 128]);
  });
});
