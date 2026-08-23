export type LngLat = [longitude: number, latitude: number];

export interface SubsolarPoint {
  longitude: number;
  latitude: number;
}

/**
 * A sampled night-opacity field, one byte per texel, row-major from the north.
 *
 * A field rather than geometry, because the terminator has no singularity-free
 * parametrisation: at an equinox the curve is a pair of meridians rather than a
 * function of longitude, and any "latitude per longitude" mesh degenerates
 * there. Sampling `darknessAt` needs no parametrisation at all, and the GPU's
 * bilinear filter does the smoothing that 2,592 flat-shaded cells could not.
 */
export interface DarknessField {
  width: number;
  height: number;
  /** `width * height` alpha bytes. Row 0 is +90°, column 0 is -180°. */
  alpha: Uint8Array;
}

const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;

function normaliseLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

function utcDayOfYear(date: Date): number {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / 86_400_000) + 1;
}

/**
 * NOAA's compact solar-position approximation, accurate to well within the
 * renderer's five-degree twilight mesh. The result is the point at which the
 * sun is directly overhead; no browser locale or host timezone enters it.
 */
export function subsolarPoint(date: Date): SubsolarPoint {
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3_600;
  const daysInYear =
    Date.UTC(date.getUTCFullYear() + 1, 0, 1) - Date.UTC(date.getUTCFullYear(), 0, 1) ===
    366 * 86_400_000
      ? 366
      : 365;
  const fractionalYear =
    ((2 * Math.PI) / daysInYear) * (utcDayOfYear(date) - 1 + (utcHours - 12) / 24);

  const equationOfTimeMinutes =
    229.18 *
    (0.000_075 +
      0.001_868 * Math.cos(fractionalYear) -
      0.032_077 * Math.sin(fractionalYear) -
      0.014_615 * Math.cos(2 * fractionalYear) -
      0.040_849 * Math.sin(2 * fractionalYear));
  const declination =
    0.006_918 -
    0.399_912 * Math.cos(fractionalYear) +
    0.070_257 * Math.sin(fractionalYear) -
    0.006_758 * Math.cos(2 * fractionalYear) +
    0.000_907 * Math.sin(2 * fractionalYear) -
    0.002_697 * Math.cos(3 * fractionalYear) +
    0.001_48 * Math.sin(3 * fractionalYear);

  return {
    latitude: declination * DEGREES,
    longitude: normaliseLongitude(180 - utcHours * 15 - equationOfTimeMinutes / 4),
  };
}

function solarDot(longitude: number, latitude: number, sun: SubsolarPoint): number {
  const latitudeRadians = latitude * RADIANS;
  const sunLatitudeRadians = sun.latitude * RADIANS;
  const longitudeDelta = (longitude - sun.longitude) * RADIANS;
  return (
    Math.sin(latitudeRadians) * Math.sin(sunLatitudeRadians) +
    Math.cos(latitudeRadians) * Math.cos(sunLatitudeRadians) * Math.cos(longitudeDelta)
  );
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const position = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return position * position * (3 - 2 * position);
}

/**
 * Where full daylight ends and full night begins, in degrees of solar elevation.
 *
 * The band between them is the terminator a player actually sees, and it was
 * originally +3 to -9: twelve degrees, which on a globe is a narrow enough smear
 * that the edge reads as a line rather than as dusk.
 *
 * These are the real thresholds instead. Astronomical twilight ends at -18, and
 * below it the sky is genuinely dark; +6 is comfortably into full day. That makes
 * the band twenty-four degrees — twice as soft, and no longer an invented number.
 */
const FULL_DAY_ELEVATION = 6;
const FULL_NIGHT_ELEVATION = -18;

/** Night opacity, with the twilight band spread across the elevations above. */
export function darknessAt(longitude: number, latitude: number, sun: SubsolarPoint): number {
  // Solar elevation is asin(dot), and `smoothstep` is monotonic, so comparing the
  // sines directly avoids an arcsine per texel across half a million of them.
  return smoothstep(
    Math.sin(FULL_DAY_ELEVATION * RADIANS),
    Math.sin(FULL_NIGHT_ELEVATION * RADIANS),
    solarDot(longitude, latitude, sun),
  );
}

/**
 * Sample the night field once, for upload as a texture.
 *
 * Regenerated once a minute, not once a frame; the renderer only animates things
 * that really move.
 *
 * **Row 0 is the north pole**, which is the row order `BitmapLayer` expects for
 * `bounds: [west, south, east, north]` — the image's top edge is the northern
 * one. Getting that backwards flips day and night, which is why there is a test
 * for it rather than a comment alone.
 *
 * Texel *centres* are sampled, not corners. A corner sample makes the first and
 * last row land exactly on a pole, where longitude is meaningless and every
 * texel in the row would carry the same value as its neighbour's corner — the
 * seam that shows up as a hard line along the antimeridian.
 */
export function createDarknessField(date: Date, width: number, height: number): DarknessField {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error('Darkness field needs an integer width and height of at least 2');
  }

  const sun = subsolarPoint(date);
  const alpha = new Uint8Array(width * height);

  for (let row = 0; row < height; row += 1) {
    const latitude = 90 - ((row + 0.5) * 180) / height;
    for (let column = 0; column < width; column += 1) {
      const longitude = -180 + ((column + 0.5) * 360) / width;
      alpha[row * width + column] = Math.round(255 * darknessAt(longitude, latitude, sun));
    }
  }

  return { width, height, alpha };
}
