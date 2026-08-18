import { type CsvRow } from '../csv';

/**
 * Turning OurAirports rows into rows we are willing to store.
 *
 * Pure functions, no database, no network — this is where all the judgement
 * lives and therefore where the tests are.
 *
 * ## The cleaning is a guard, not a repair
 *
 * Measured against the 2026-08-17 dataset (85,915 airports, 48,167 runways),
 * every check below currently rejects **nothing**: no missing coordinates, no
 * duplicate identifiers, no malformed ICAO or IATA codes, no blank countries.
 * M1-01 asks for cleaning anyway, and it is still worth writing, because the
 * upstream file is community-edited and republished continually. The value is
 * not in what it fixes today; it is that a bad row in six months' time is
 * rejected and counted instead of being stored as an airport at 0°N 0°E.
 *
 * That is also why nothing here throws on a bad row. A single malformed entry
 * must not stop 85,000 good ones from importing — it is dropped, counted, and
 * reported.
 */

export type AirportKind =
  | 'large_airport'
  | 'medium_airport'
  | 'small_airport'
  | 'heliport'
  | 'seaplane_base'
  | 'balloonport'
  | 'closed';

const AIRPORT_KINDS = new Set<string>([
  'large_airport',
  'medium_airport',
  'small_airport',
  'heliport',
  'seaplane_base',
  'balloonport',
  'closed',
]);

/** Matches the `RunwaySurface` enum in `@tailfin/shared`. */
export type RunwaySurface = 'asphalt' | 'concrete' | 'gravel' | 'grass' | 'water' | 'other';

export interface NormalisedAirport {
  sourceId: number;
  ident: string;
  icaoCode: string | null;
  iataCode: string | null;
  name: string;
  municipality: string | null;
  isoCountry: string;
  isoRegion: string | null;
  continent: string | null;
  kind: AirportKind;
  latitude: number;
  longitude: number;
  elevationFt: number | null;
  scheduledService: boolean;
}

export interface NormalisedRunway {
  sourceId: number;
  airportIdent: string;
  identifier: string;
  lengthFt: number | null;
  widthFt: number | null;
  surfaceRaw: string | null;
  surface: RunwaySurface;
  lighted: boolean;
  closed: boolean;
}

export interface RejectedRow {
  /** The row's identifier where it has one, so a rejection can be looked up in the source. */
  key: string;
  reason: string;
}

export interface NormaliseResult<T> {
  rows: T[];
  rejected: RejectedRow[];
}

// ---------------------------------------------------------------- helpers ----

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

function blankToNull(value: string | undefined): string | null {
  const text = trimmed(value);
  return text === '' ? null : text;
}

/**
 * Strict numeric parse.
 *
 * `Number('')` is 0 and `parseInt('12abc')` is 12; both would turn junk into a
 * plausible measurement. Anything not wholly numeric is treated as absent.
 */
function numberOrNull(value: string | undefined): number | null {
  const text = trimmed(value);
  if (text === '') return null;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value: string | undefined): number | null {
  const parsed = numberOrNull(value);
  if (parsed === null) return null;
  return Number.isInteger(parsed) ? parsed : Math.round(parsed);
}

/**
 * The dataset uses 664 distinct spellings for what is really a handful of
 * surfaces — `ASP`, `ASPH`, `Asphalt`, `asphalt-g`, and so on. Matching by
 * substring on an upper-cased string collapses them without needing to enumerate
 * every variant.
 *
 * **Order matters.** `CONC` contains no `ASP`, but several composite values name
 * two surfaces (`ASP-CONC`); first match wins, which is the harder surface, and
 * that is the conservative direction for a runway-suitability check.
 *
 * The raw value is stored alongside this, so a better mapping later can be
 * re-derived without another import.
 */
export function normaliseSurface(raw: string | undefined): RunwaySurface {
  const text = trimmed(raw).toUpperCase();
  if (text === '') return 'other';

  if (/\b(?:CON|CONC|CONCRETE|PEM|PSP)\b|CONC|CEMENT/.test(text)) return 'concrete';
  if (/ASP|BIT|TAR|MAC|PAVED/.test(text)) return 'asphalt';
  if (/GRVL|GVL|GRAVEL|CORAL|SHELL|STONE|LATERITE/.test(text)) return 'gravel';
  if (/GRS|GRE|GRASS|TURF|SOD/.test(text)) return 'grass';
  if (/WATER|WAT-|^WAT$/.test(text)) return 'water';
  return 'other';
}

// -------------------------------------------------------------- airports ----

export function normaliseAirports(rows: CsvRow[]): NormaliseResult<NormalisedAirport> {
  const out: NormalisedAirport[] = [];
  const rejected: RejectedRow[] = [];
  const seenIdents = new Set<string>();
  const seenIcao = new Set<string>();
  const seenIata = new Set<string>();

  for (const row of rows) {
    const ident = trimmed(row.ident).toUpperCase();
    const key = ident === '' ? `id=${trimmed(row.id)}` : ident;

    if (ident === '') {
      rejected.push({ key, reason: 'blank ident' });
      continue;
    }
    if (ident.length > 16) {
      rejected.push({ key, reason: 'ident longer than 16 characters' });
      continue;
    }
    if (seenIdents.has(ident)) {
      rejected.push({ key, reason: 'duplicate ident' });
      continue;
    }

    const sourceId = integerOrNull(row.id);
    if (sourceId === null) {
      rejected.push({ key, reason: 'missing source id' });
      continue;
    }

    const latitude = numberOrNull(row.latitude_deg);
    const longitude = numberOrNull(row.longitude_deg);
    if (latitude === null || longitude === null) {
      rejected.push({ key, reason: 'missing coordinates' });
      continue;
    }
    // 0,0 is in the Gulf of Guinea. It is the classic "the geocoder failed"
    // value, and no aerodrome is there.
    if (latitude === 0 && longitude === 0) {
      rejected.push({ key, reason: 'null island coordinates' });
      continue;
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      rejected.push({ key, reason: 'coordinates out of range' });
      continue;
    }

    const name = trimmed(row.name);
    if (name === '') {
      rejected.push({ key, reason: 'blank name' });
      continue;
    }

    const isoCountry = trimmed(row.iso_country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(isoCountry)) {
      rejected.push({
        key,
        reason: `country code ${JSON.stringify(isoCountry)} is not ISO 3166-1 alpha-2`,
      });
      continue;
    }

    const rawKind = trimmed(row.type);
    if (!AIRPORT_KINDS.has(rawKind)) {
      // A new `type` value upstream is a change we want to notice, not absorb.
      rejected.push({ key, reason: `unknown airport type ${JSON.stringify(rawKind)}` });
      continue;
    }

    // Codes are dropped rather than the whole row when malformed: an airport
    // with a broken IATA code is still an airport, and it still has geography.
    let icaoCode = blankToNull(row.icao_code);
    if (icaoCode !== null) {
      icaoCode = icaoCode.toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(icaoCode) || seenIcao.has(icaoCode)) icaoCode = null;
      else seenIcao.add(icaoCode);
    }

    let iataCode = blankToNull(row.iata_code);
    if (iataCode !== null) {
      iataCode = iataCode.toUpperCase();
      if (!/^[A-Z0-9]{3}$/.test(iataCode) || seenIata.has(iataCode)) iataCode = null;
      else seenIata.add(iataCode);
    }

    const elevationFt = integerOrNull(row.elevation_ft);

    seenIdents.add(ident);
    out.push({
      sourceId,
      ident,
      icaoCode,
      iataCode,
      name,
      municipality: blankToNull(row.municipality),
      isoCountry,
      isoRegion: blankToNull(row.iso_region),
      continent: blankToNull(row.continent),
      kind: rawKind as AirportKind,
      latitude,
      longitude,
      // Beyond this range is a unit error or a typo, not an aerodrome. The
      // Dead Sea sits near -1,240 ft and Daocheng Yading near 14,472 ft.
      elevationFt:
        elevationFt !== null && elevationFt >= -2000 && elevationFt <= 30000 ? elevationFt : null,
      scheduledService: trimmed(row.scheduled_service).toLowerCase() === 'yes',
    });
  }

  return { rows: out, rejected };
}

// --------------------------------------------------------------- runways ----

export function normaliseRunways(
  rows: CsvRow[],
  knownIdents: ReadonlySet<string>,
): NormaliseResult<NormalisedRunway> {
  const out: NormalisedRunway[] = [];
  const rejected: RejectedRow[] = [];
  const seenSourceIds = new Set<number>();

  for (const row of rows) {
    const airportIdent = trimmed(row.airport_ident).toUpperCase();
    const sourceId = integerOrNull(row.id);
    const key = `runway ${String(sourceId ?? '?')} @ ${airportIdent || '?'}`;

    if (sourceId === null) {
      rejected.push({ key, reason: 'missing source id' });
      continue;
    }
    if (seenSourceIds.has(sourceId)) {
      rejected.push({ key, reason: 'duplicate source id' });
      continue;
    }
    // A runway whose airport was rejected has nothing to hang off, and the
    // foreign key would refuse it anyway.
    if (!knownIdents.has(airportIdent)) {
      rejected.push({ key, reason: 'airport not in the imported set' });
      continue;
    }

    const lengthFt = integerOrNull(row.length_ft);
    const widthFt = integerOrNull(row.width_ft);

    // A runway end is named by its heading — "09/27", "18L/36R". Either end may
    // be blank in the source; a runway with neither is unusable as a reference.
    const leIdent = trimmed(row.le_ident);
    const heIdent = trimmed(row.he_ident);
    const identifier = [leIdent, heIdent].filter((part) => part !== '').join('/');
    if (identifier === '') {
      rejected.push({ key, reason: 'no runway end identifier' });
      continue;
    }

    seenSourceIds.add(sourceId);
    out.push({
      sourceId,
      airportIdent,
      identifier: identifier.slice(0, 16),
      // Zero and negative lengths exist upstream. Unknown is the honest value —
      // a runway of length 0 would read as a real, unusably short runway.
      lengthFt: lengthFt !== null && lengthFt > 0 ? lengthFt : null,
      widthFt: widthFt !== null && widthFt > 0 ? widthFt : null,
      surfaceRaw: blankToNull(row.surface),
      surface: normaliseSurface(row.surface),
      lighted: trimmed(row.lighted) === '1',
      closed: trimmed(row.closed) === '1',
    });
  }

  return { rows: out, rejected };
}
