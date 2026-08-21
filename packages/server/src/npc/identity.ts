import { type NpcArchetype } from '@tailfin/shared';
import { type Rng, intBetween } from '@tailfin/sim';

/**
 * What an NPC carrier is called (M3-12).
 *
 * Names are built from the **hub's own city**, because that is real data the
 * world already holds and because "Barcelona Express" reads like an airline in
 * a way that a generated syllable never will. The alternative — a table of
 * invented names — would be a second dataset to maintain and would place a
 * Portuguese-sounding carrier in Finland the first time somebody reordered it.
 *
 * Every string here has to satisfy the `airline` table's own checks, which are
 * strict and were written for player input: a name of 1–120 characters with no
 * control characters and no double spaces, a two-character alphanumeric IATA
 * code, a three-letter ICAO code, and a callsign of uppercase alphanumeric
 * words. Those checks are the reason this file exists rather than a template
 * string at the call site — an NPC that fails a constraint fails the seed.
 */

export interface NpcIdentity {
  name: string;
  iataCode: string;
  icaoCode: string;
  callsign: string;
}

/** Name templates per archetype. `{city}` is the hub's municipality. */
const TEMPLATES: Record<NpcArchetype, readonly string[]> = {
  flag: ['{city} Airlines', '{city} Airways', 'Air {city}', '{city} National'],
  lcc: ['{city} Express', 'Fly {city}', '{city} Blue', '{city} Go'],
  regional: ['{city} Regional', '{city} Connect', '{city} Link', '{city} Commuter'],
  charter: ['{city} Holidays', 'Sun {city}', '{city} Leisure', '{city} Charter'],
};

/**
 * A city name reduced to what the database will accept.
 *
 * Diacritics are folded rather than stripped, so Zürich becomes Zurich and not
 * Zrich. Anything else non-alphabetic becomes a space, and runs of spaces
 * collapse — `airline_name_structure` refuses a double space outright, and an
 * airline called "Ho  Chi Minh Airlines" would fail the insert rather than look
 * slightly wrong.
 */
export function cleanCityName(raw: string): string {
  const folded = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const letters = folded
    .replace(/[^A-Za-z]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (letters === '') return '';

  // Title case, so a source that shouts or whispers reads the same either way.
  return letters
    .split(' ')
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** The alphabet the code checks allow, in a fixed order so a seed replays. */
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALPHANUMERIC = `${ALPHA}0123456789`;

/**
 * A carrier's identity, or `null` when every candidate code is taken.
 *
 * Codes are scarce — §24 counts roughly 1,300 usable two-letter IATA codes
 * against an unbounded player count — so this tries a bounded number of
 * candidates and then gives up rather than looping. A world that cannot fit
 * another NPC is a world that should stop seeding them, not one that should
 * spin.
 *
 * `taken` is mutated as codes are claimed, so a caller seeding sixty carriers
 * passes one set through and never allocates the same code twice.
 */
export function makeIdentity(
  rng: Rng,
  archetype: NpcArchetype,
  city: string,
  takenIata: Set<string>,
  takenIcao: Set<string>,
  attempts = 64,
): NpcIdentity | null {
  const cleaned = cleanCityName(city);
  if (cleaned === '') return null;

  const templates = TEMPLATES[archetype];
  const name = templates[intBetween(rng, 0, templates.length - 1)]!.replace('{city}', cleaned);
  if (name.length > 120) return null;

  // The callsign is the name in the form the checks demand: uppercase
  // alphanumeric words, at least one letter, single-spaced.
  const callsign = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (callsign === '' || !/[A-Z]/.test(callsign) || callsign.length > 32) return null;

  const initials = cleaned
    .split(' ')
    .map((w) => w[0]!.toUpperCase())
    .join('');

  const iata = pick(
    attempts,
    () => {
      const first = initials[0] ?? ALPHA[intBetween(rng, 0, 25)]!;
      const second = ALPHANUMERIC[intBetween(rng, 0, ALPHANUMERIC.length - 1)]!;
      return `${first}${second}`;
    },
    takenIata,
  );
  if (iata === null) return null;

  const icao = pick(
    attempts,
    () => {
      const letters = [0, 1, 2].map((i) =>
        (initials[i] ?? ALPHA[intBetween(rng, 0, 25)]!).toUpperCase(),
      );
      // The last letter is always drawn, so three carriers from one city do not
      // all propose the same code and burn the attempt budget on collisions.
      letters[2] = ALPHA[intBetween(rng, 0, 25)]!;
      return letters.join('');
    },
    takenIcao,
  );
  if (icao === null) return null;

  takenIata.add(iata);
  takenIcao.add(icao);
  return { name, iataCode: iata, icaoCode: icao, callsign };
}

function pick(attempts: number, propose: () => string, taken: Set<string>): string | null {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = propose();
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}
