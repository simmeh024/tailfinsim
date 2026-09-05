/**
 * Identities for airports a test invents (BUG-11).
 *
 * `airport` has three unique columns — `icao_code`, `ident` and `source_id` —
 * and for a long time most suites filled all three from `Math.random()`. Two
 * shapes were in use: four random letters, and `Z` followed by three characters
 * of `Math.random().toString(36)`. The second is worse than it looks, because
 * that string is not guaranteed long enough to slice three characters out of:
 * `0.5` slices to `5`, and the code becomes `Q5`.
 *
 * Randomness fails the way randomness does. `schedule/prepare-legs.test.ts`
 * makes eleven airports from a ~46,000-code space, which collides roughly once
 * in eight hundred runs — and it did, on a pull request that touched nothing in
 * `packages/schedule`:
 *
 * > duplicate key value violates unique constraint "airport_ident_key"
 * > Key (ident)=(PREP-QKIM) already exists.
 *
 * That is the expensive part. The failure names somebody else's file and points
 * the author at their own diff, where there is nothing to find.
 *
 * `npc/npc.test.ts` had already worked this out and used a serial, with the
 * reasoning written next to it. This is that idea made shared, so every suite
 * gets it and no suite can collide with another one.
 *
 * ## Why the codes start with `Q`
 *
 * Two reasons, and the second is the one that was actually broken.
 *
 * A namespace letter per suite means two suites running concurrently — which
 * vitest does, against one database — cannot mint the same code however many
 * airports they make. Within a suite the remaining two letters are a **serial**,
 * so a repeat is impossible rather than improbable.
 *
 * And **no real ICAO location indicator begins with `Q`**: the letter is
 * reserved and unassigned. Test airports therefore cannot collide with imported
 * OurAirports data either. Three suites previously prefixed `Z`, which is China
 * and Korea — `ZBAA` is Beijing Capital — so a test row and a real row were one
 * unlucky draw apart in any database where the import had run. `npc.test.ts`'s
 * own comment worried about exactly that and could not fix it with a prefix it
 * had already chosen.
 */

/**
 * One letter per suite that invents airports.
 *
 * Keyed by the suite's path so the mapping is greppable from either direction,
 * and asserted distinct in `airport-codes.test.ts` — a duplicate here would put
 * two suites back in one namespace, which is the failure this exists to remove.
 */
export const AIRPORT_CODE_NAMESPACES = {
  'demand/generate': 'A',
  'flight/ferry': 'B',
  'flight/settle': 'C',
  'flight/settle-fuel': 'D',
  'network/connections-db': 'E',
  'network/performance-db': 'F',
  'network/slots-db': 'G',
  'npc/npc': 'H',
  'schedule/lifecycle': 'I',
  'schedule/prepare-legs': 'J',
  'schedule/read': 'K',
  'schedule/store': 'L',
} as const;

export type AirportCodeNamespace = keyof typeof AIRPORT_CODE_NAMESPACES;

/** The three unique columns, minted together because they are one identity. */
export interface TestAirportIdentity {
  /** Four uppercase characters, as `airport_icao_code_format` requires. */
  icaoCode: string;
  ident: string;
  /**
   * Negative, because every real OurAirports id is positive — so a test row is
   * recognisable as one, and can never collide with imported data.
   */
  sourceId: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Serials per namespace, so one suite's two allocators do not overlap. */
const PER_NAMESPACE = LETTERS.length * LETTERS.length;

/**
 * Well clear of the hand-picked negative bases suites already use (which sit
 * around -9,600,000), so converting a suite cannot collide with one that has
 * not been converted.
 */
const SOURCE_ID_BASE = 50_000_000;

/**
 * A serial allocator of airport identities for one suite.
 *
 * Call it once per airport. The suite's own cleanup is unchanged: these are
 * ordinary rows and it still deletes exactly the ones it made.
 *
 * Throws rather than wrapping past 676 airports. Wrapping would reintroduce the
 * collision this exists to remove, silently and only in the suite that had grown
 * large enough to hit it.
 */
export function createAirportIdentities(
  namespace: AirportCodeNamespace,
): () => TestAirportIdentity {
  const letter = AIRPORT_CODE_NAMESPACES[namespace];
  const index = Object.keys(AIRPORT_CODE_NAMESPACES).indexOf(namespace);
  let serial = 0;

  return () => {
    const n = serial++;
    if (n >= PER_NAMESPACE) {
      throw new Error(
        `${namespace} has minted ${String(PER_NAMESPACE)} test airports, which is all its ` +
          'namespace holds. Give it a second namespace rather than letting the codes wrap.',
      );
    }
    const icaoCode = `Q${letter}${LETTERS[Math.floor(n / LETTERS.length)] ?? 'A'}${LETTERS[n % LETTERS.length] ?? 'A'}`;
    return {
      icaoCode,
      ident: `TEST-${icaoCode}`,
      sourceId: -(SOURCE_ID_BASE + index * PER_NAMESPACE + n),
    };
  };
}
