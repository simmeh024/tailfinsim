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
  /** `width * height` alpha bytes. Row 0 is the northern bound, column 0 is -180°. */
  alpha: Uint8Array;
  /** The latitude of row 0, and of the last row negated. See {@link RowSpacing}. */
  northLatitude: number;
}

/**
 * How the field's rows are distributed in latitude.
 *
 * The field is uploaded as a texture and stretched over a quad, so its rows have
 * to be spaced the way the **viewport** spaces latitude — otherwise the day/night
 * boundary lands at the wrong latitude, increasingly so away from the equator.
 *
 * - `equirectangular` — equal degrees per row, covering the full ±90°. What the
 *   globe wants, because `_GlobeView` places a quad's vertices by latitude.
 * - `mercator` — equal *Web Mercator* units per row, covering ±85.051129°. What
 *   the flat map wants, because that is what Web Mercator does with the sheet.
 *
 * deck.gl offers `_imageCoordinateSystem: 'lnglat'` to do this conversion in the
 * shader instead, and it does not survive a world-sized quad: with
 * `bounds: [-180, -90, 180, 90]` on the flat map it squashed the entire field
 * into a tapering horizontal wedge across the equator. Generating the rows to
 * match the projection needs no conversion at all, so there is none.
 */
export type RowSpacing = 'equirectangular' | 'mercator';

/**
 * The pole of a Web Mercator sheet — the latitude whose mercator `y` makes the
 * world square. Beyond it the projection runs to infinity, which is why every
 * slippy map in existence stops here and why the flat field cannot use ±90°.
 */
export const WEB_MERCATOR_MAX_LATITUDE = 85.051129;

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

/** Web Mercator's northing for a latitude, in the projection's own units. */
function mercatorY(latitude: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latitude * RADIANS) / 2));
}

/** The inverse of {@link mercatorY}. */
function latitudeAtMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEGREES;
}

/**
 * Sample the night field once, for upload as a texture.
 *
 * Regenerated once a minute, not once a frame; the renderer only animates things
 * that really move.
 *
 * **Row 0 is the northern edge**, which is the row order `BitmapLayer` expects
 * for `bounds: [west, south, east, north]` — the image's top edge is the northern
 * one. Getting that backwards flips day and night, which is why there is a test
 * for it rather than a comment alone.
 *
 * `spacing` says how the rows are distributed and therefore what northern edge
 * they reach; the caller must give the layer `bounds` with the matching
 * `northLatitude`. See {@link RowSpacing}.
 *
 * Texel *centres* are sampled, not corners. A corner sample makes the first and
 * last row land exactly on a pole, where longitude is meaningless and every
 * texel in the row would carry the same value as its neighbour's corner — the
 * seam that shows up as a hard line along the antimeridian.
 */
export function createDarknessField(
  date: Date,
  width: number,
  height: number,
  spacing: RowSpacing = 'equirectangular',
): DarknessField {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new Error('Darkness field needs an integer width and height of at least 2');
  }

  const sun = subsolarPoint(date);
  const alpha = new Uint8Array(width * height);
  const northLatitude = spacing === 'mercator' ? WEB_MERCATOR_MAX_LATITUDE : 90;
  // The mercator `y` of the northern edge; rows step evenly between +y and -y.
  const northY = spacing === 'mercator' ? mercatorY(northLatitude) : 0;

  for (let row = 0; row < height; row += 1) {
    const fraction = (row + 0.5) / height;
    const latitude =
      spacing === 'mercator'
        ? latitudeAtMercatorY(northY * (1 - 2 * fraction))
        : northLatitude - fraction * 2 * northLatitude;
    for (let column = 0; column < width; column += 1) {
      const longitude = -180 + ((column + 0.5) * 360) / width;
      alpha[row * width + column] = Math.round(255 * darknessAt(longitude, latitude, sun));
    }
  }

  return { width, height, alpha, northLatitude };
}
