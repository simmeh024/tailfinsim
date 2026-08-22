export type LngLat = [longitude: number, latitude: number];

export interface SubsolarPoint {
  longitude: number;
  latitude: number;
}

export interface TerminatorCell {
  polygon: [LngLat, LngLat, LngLat, LngLat];
  darkness: number;
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

/** Night opacity with a soft civil-twilight band around the geometric terminator. */
export function darknessAt(longitude: number, latitude: number, sun: SubsolarPoint): number {
  // Solar elevation is asin(dot). Full day above +3°, full night below -9°.
  return smoothstep(
    Math.sin(3 * RADIANS),
    Math.sin(-9 * RADIANS),
    solarDot(longitude, latitude, sun),
  );
}

/**
 * A static GPU-friendly mesh for the night hemisphere. It is regenerated once
 * a minute, not once a frame; the renderer only animates things that really move.
 */
export function createTerminatorCells(date: Date, stepDegrees = 5): TerminatorCell[] {
  if (stepDegrees <= 0 || 180 % stepDegrees !== 0 || 360 % stepDegrees !== 0) {
    throw new Error('Terminator step must be a positive divisor of both 180 and 360 degrees');
  }

  const sun = subsolarPoint(date);
  const cells: TerminatorCell[] = [];
  for (let latitude = -90; latitude < 90; latitude += stepDegrees) {
    for (let longitude = -180; longitude < 180; longitude += stepDegrees) {
      const north = latitude + stepDegrees;
      const east = longitude + stepDegrees;
      cells.push({
        polygon: [
          [longitude, latitude],
          [east, latitude],
          [east, north],
          [longitude, north],
        ],
        darkness: darknessAt(longitude + stepDegrees / 2, latitude + stepDegrees / 2, sun),
      });
    }
  }
  return cells;
}
