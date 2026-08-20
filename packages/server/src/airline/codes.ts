import { eq } from 'drizzle-orm';

import {
  type AirlineCodeAvailabilityAdvisory,
  type AirlineCodeAvailabilityInput,
  type AirlineCodeAvailabilityResponse,
  type AirlineCodeKind,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, world } from '../db/schema';

const IATA_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ICAO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const AIRLINE_CODE_ALTERNATIVE_LIMIT = 3;

export interface AirlineCodeAllocationPolicy {
  /** AIR-04 records this explicitly so real-world handling cannot be accidental. */
  realWorldCodes: 'allowed-if-free' | 'reserved';
  isReserved(kind: AirlineCodeKind, code: string): boolean;
}

/**
 * M11-08 decision: Tailfin does not ship a stale imitation of a licensed,
 * changing real-world registry. A real-world designator may therefore be used
 * when it is free in this Tailfin world; name moderation remains separate.
 */
export const tailfinAirlineCodePolicy: AirlineCodeAllocationPolicy = Object.freeze({
  realWorldCodes: 'allowed-if-free',
  isReserved: () => false,
});

export const AIRLINE_CODE_AVAILABILITY_ADVISORY: AirlineCodeAvailabilityAdvisory = Object.freeze({
  scope: 'world',
  reservation: 'none',
  realWorldCodes: tailfinAirlineCodePolicy.realWorldCodes,
  message:
    'Availability is advisory within this Tailfin world. A code is not reserved until airline founding succeeds.',
});

export function airlineCodeAvailabilityAdvisory(
  policy: AirlineCodeAllocationPolicy = tailfinAirlineCodePolicy,
): AirlineCodeAvailabilityAdvisory {
  return { ...AIRLINE_CODE_AVAILABILITY_ADVISORY, realWorldCodes: policy.realWorldCodes };
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value.normalize('NFC')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function encodeCode(value: number, alphabet: string, length: number): string {
  let remainder = value;
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code = `${alphabet[remainder % alphabet.length] ?? alphabet[0] ?? 'A'}${code}`;
    remainder = Math.floor(remainder / alphabet.length);
  }
  return code;
}

function latinWords(name: string): string[] {
  return (
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toUpperCase()
      .match(/[A-Z]+/g) ?? []
  );
}

function lexicalCandidates(name: string, kind: AirlineCodeKind): string[] {
  const words = latinWords(name);
  const first = words[0] ?? '';
  const last = words.at(-1) ?? '';
  const initials = words.map((word) => word[0] ?? '').join('');
  const letters = words.join('');

  if (kind === 'iata') {
    return [
      initials.slice(0, 2),
      first.slice(0, 2),
      letters.slice(0, 2),
      `${first[0] ?? ''}${last[0] ?? ''}`,
      `${first[0] ?? ''}${first.at(-1) ?? ''}`,
      `${first[0] ?? ''}${last.at(-1) ?? ''}`,
    ].filter((candidate) => /^[A-Z0-9]{2}$/.test(candidate));
  }

  return [
    initials.slice(0, 3),
    letters.slice(0, 3),
    first.slice(0, 3),
    `${first[0] ?? ''}${last.slice(0, 2)}`,
    `${first[0] ?? ''}${first.at(-3) ?? ''}${first.at(-1) ?? ''}`,
    `${first.slice(0, 2)}${last[0] ?? ''}`,
  ].filter((candidate) => /^[A-Z]{3}$/.test(candidate));
}

/**
 * Every valid code in a deterministic, name-derived order.
 *
 * Readable initials and letter combinations lead. A stable Unicode hash then
 * walks the complete namespace with a coprime step, which means names without
 * a Latin transliteration still get deterministic alternatives and an almost
 * full world can still find its final free code.
 */
export function rankedAirlineCodeCandidates(name: string, kind: AirlineCodeKind): string[] {
  const alphabet = kind === 'iata' ? IATA_ALPHABET : ICAO_ALPHABET;
  const length = kind === 'iata' ? 2 : 3;
  const namespaceSize = alphabet.length ** length;
  const candidates = new Set(lexicalCandidates(name, kind));
  const start = stableHash(`${kind}:${name}`) % namespaceSize;

  for (let offset = 0; offset < namespaceSize; offset += 1) {
    candidates.add(encodeCode((start + offset * 5) % namespaceSize, alphabet, length));
  }
  return [...candidates];
}

export function suggestAirlineCodes(
  name: string,
  kind: AirlineCodeKind,
  unavailable: ReadonlySet<string>,
  policy: AirlineCodeAllocationPolicy = tailfinAirlineCodePolicy,
  limit = AIRLINE_CODE_ALTERNATIVE_LIMIT,
): string[] {
  const suggestions: string[] = [];
  for (const candidate of rankedAirlineCodeCandidates(name, kind)) {
    if (unavailable.has(candidate) || policy.isReserved(kind, candidate)) continue;
    suggestions.push(candidate);
    if (suggestions.length === limit) break;
  }
  return suggestions;
}

interface UsedCodes {
  iata: Set<string>;
  icao: Set<string>;
}

async function usedCodesInWorld(db: Database, worldId: string): Promise<UsedCodes> {
  const rows = await db
    .select({ iataCode: airline.iataCode, icaoCode: airline.icaoCode })
    .from(airline)
    .where(eq(airline.worldId, worldId));
  return {
    iata: new Set(rows.map((row) => row.iataCode)),
    icao: new Set(rows.map((row) => row.icaoCode)),
  };
}

export async function availableAirlineCodeAlternatives(
  db: Database,
  worldId: string,
  name: string,
  kind: AirlineCodeKind,
  excluded: readonly string[] = [],
  policy: AirlineCodeAllocationPolicy = tailfinAirlineCodePolicy,
): Promise<string[]> {
  const used = await usedCodesInWorld(db, worldId);
  const unavailable = kind === 'iata' ? used.iata : used.icao;
  for (const code of excluded) unavailable.add(code);
  return suggestAirlineCodes(name, kind, unavailable, policy);
}

export type CheckAirlineCodeAvailabilityResult =
  | { ok: false; kind: 'world-not-found'; worldId: string }
  | { ok: true; availability: AirlineCodeAvailabilityResponse };

export async function checkAirlineCodeAvailability(
  db: Database,
  input: AirlineCodeAvailabilityInput,
  policy: AirlineCodeAllocationPolicy = tailfinAirlineCodePolicy,
): Promise<CheckAirlineCodeAvailabilityResult> {
  const worlds = await db
    .select({ id: world.id })
    .from(world)
    .where(eq(world.id, input.worldId))
    .limit(1);
  if (!worlds[0]) return { ok: false, kind: 'world-not-found', worldId: input.worldId };

  const used = await usedCodesInWorld(db, input.worldId);
  const iataStatus = policy.isReserved('iata', input.iataCode)
    ? 'reserved'
    : used.iata.has(input.iataCode)
      ? 'assigned'
      : 'available';
  const icaoStatus = policy.isReserved('icao', input.icaoCode)
    ? 'reserved'
    : used.icao.has(input.icaoCode)
      ? 'assigned'
      : 'available';

  return {
    ok: true,
    availability: {
      advisory: airlineCodeAvailabilityAdvisory(policy),
      iataCode: {
        requested: input.iataCode,
        status: iataStatus,
        alternatives:
          iataStatus === 'available'
            ? []
            : suggestAirlineCodes(input.name, 'iata', used.iata, policy),
      },
      icaoCode: {
        requested: input.icaoCode,
        status: icaoStatus,
        alternatives:
          icaoStatus === 'available'
            ? []
            : suggestAirlineCodes(input.name, 'icao', used.icao, policy),
      },
    },
  };
}
