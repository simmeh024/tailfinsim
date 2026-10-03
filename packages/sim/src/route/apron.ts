/**
 * Where the airport map draws each aeroplane on the ground (M7-07, App. B.7).
 *
 * ## A display rule, not a gate allocator
 *
 * **The game stores no gate assignment.** App. B.7 files *"gate assignment as an
 * optimisation puzzle"* under post-MVP, and nothing in the operation reads which
 * stand an aeroplane is on: a turn is priced by `resolveStands` from *what the
 * airline holds* at the airport — a leased contact gate, a leased remote stand,
 * or a walk-up onto whatever the leases have left — never from a position. So
 * this function decides nothing the game acts on. It answers one question for a
 * picture: *given who holds what and who is on the ground, where would each
 * aeroplane plausibly be standing?* — deterministically, so the same apron draws
 * the same way on every refresh and for every viewer.
 *
 * It is written to agree with the model it illustrates rather than to be
 * clever:
 *
 *   1. **An airline's aeroplanes stand on its own stands first.** That is what a
 *      lease is for, and the resolver turns an airline with a leased contact
 *      gate from a contact gate. Exclusive before preferential, contact gates
 *      before remote stands, inventory order within each.
 *   2. **A walk-up only takes a stand nobody holds.** `resolveStands` counts a
 *      walk-up's spare contact gates as the airport's total minus every leased
 *      one, so a rival's preferential gate is not spare — and drawing a walk-up
 *      on it would show a state the game disagrees with.
 *   3. **Holders are placed before walk-ups**, whatever the arrival order. A
 *      preferential holder outranks a walk-up (App. B.6), so an earlier rival
 *      walk-up never takes the stand a holder's aeroplane is about to use.
 *   4. **An aeroplane with nothing to do is parked, not turned.** No departure
 *      within {@link APRON_PARKED_AFTER_MINUTES} puts it on overnight parking,
 *      then the remote apron — never on a contact gate somebody could turn from.
 *   5. **A freighter prefers a cargo stand**, then the passenger chain.
 *   6. **Null when nothing fits.** The map puts it on the remote apron unnamed
 *      rather than inventing a stand the airport does not have.
 *
 * ## Why this is not `assignStands`
 *
 * M7-06's greedy colouring places a *day of intervals* onto *anonymous* stand
 * indices to measure utilisation. This places the aeroplanes on the ground *at
 * one instant* onto *named* stands with owners — every one of them overlaps every
 * other, so there is nothing to colour, and the whole question is ownership,
 * which the colouring does not know about. What it does reuse is the colouring's
 * answer: an aeroplane whose current turn M7-06's measurement put on one of its
 * airline's own stands carries that stand in as `measuredPosition`, and is drawn
 * there. The gate panel's rotation and the picture therefore agree about who is
 * on which gate.
 */

import type {
  AircraftClass,
  ApronAircraftSize,
  GateContract,
  StandKind,
  WingspanCode,
} from '@tailfin/shared';

/**
 * How far ahead a departure has to be for an aeroplane to count as turning.
 *
 * Four game hours: longer than any modelled turn — the catalogue's longest
 * baseline is the 747-8F's 210 minutes, and a remote stand adds about eleven —
 * so anything waiting longer than this is waiting, not being turned, and an
 * airport would tow it off the gate. A display threshold rather than balance:
 * it prices nothing and decides nothing the game acts on.
 */
export const APRON_PARKED_AFTER_MINUTES = 4 * 60;

/** One stand as the apron sees it: where, what kind, and who holds it. */
export interface ApronStandFacts {
  position: string;
  kind: StandKind;
  holders: readonly { airlineId: string; contract: GateContract }[];
}

/** One aeroplane on the ground. Instants are **game** time, as epoch milliseconds. */
export interface ApronOccupantFacts {
  /** Stable per stay — the id of the flight that brought it. Breaks arrival-time ties. */
  key: string;
  airlineId: string;
  arrivedAt: number;
  /** Its next departure from here, or null when none is scheduled. */
  departsAt: number | null;
  freighter: boolean;
  /**
   * The stand M7-06's own measurement put this aeroplane's current turn on, when
   * that is one of its airline's stands — honoured first, so the picture and the
   * gate's rotation agree. Null otherwise.
   */
  measuredPosition: string | null;
}

/** Whether this aeroplane is parked rather than being turned, at `now`. */
export function isParkedOnApron(
  occupant: Pick<ApronOccupantFacts, 'departsAt'>,
  now: number,
  parkedAfterMinutes: number = APRON_PARKED_AFTER_MINUTES,
): boolean {
  return occupant.departsAt === null || occupant.departsAt - now > parkedAfterMinutes * 60_000;
}

/** Exclusive first: the stronger holding is the one the airline would use. */
function contractRank(contract: GateContract): number {
  switch (contract) {
    case 'exclusive':
      return 0;
    case 'preferential':
      return 1;
    case 'common_use':
      return 2;
  }
}

/** One step of an aeroplane's search: whose stands, of which kind. */
interface Step {
  whose: 'own' | 'pool';
  kind: StandKind;
}

/** The order an aeroplane looks for a stand in, by what it is doing. */
function stepsFor(occupant: ApronOccupantFacts, parked: boolean): Step[] {
  if (parked) {
    return [
      { whose: 'own', kind: 'overnight_parking' },
      { whose: 'pool', kind: 'overnight_parking' },
      { whose: 'pool', kind: 'remote_stand' },
    ];
  }
  const passenger: Step[] = [
    { whose: 'own', kind: 'contact_gate' },
    { whose: 'own', kind: 'remote_stand' },
    { whose: 'pool', kind: 'contact_gate' },
    { whose: 'pool', kind: 'remote_stand' },
  ];
  if (!occupant.freighter) return passenger;
  return [
    { whose: 'own', kind: 'cargo_stand' },
    ...passenger.filter((step) => step.whose === 'own'),
    { whose: 'pool', kind: 'cargo_stand' },
    ...passenger.filter((step) => step.whose === 'pool'),
  ];
}

/**
 * The stand each aeroplane on the ground is drawn on, by its `key`.
 *
 * Pure and deterministic: the same stands, aeroplanes and instant give the same
 * answer whatever order they arrive in. Aeroplanes are taken in arrival order,
 * ties broken by `key`, and placed in three passes — measured positions, then
 * each airline onto its own stands, then everyone left onto the stands nobody
 * holds. See the module comment for why each rule is the one it is.
 */
export function assignApronStands(
  stands: readonly ApronStandFacts[],
  occupants: readonly ApronOccupantFacts[],
  now: number,
  parkedAfterMinutes: number = APRON_PARKED_AFTER_MINUTES,
): Map<string, string | null> {
  const byPosition = new Map(stands.map((stand, index) => [stand.position, { stand, index }]));
  const taken = new Set<string>();
  const placed = new Map<string, string | null>();

  const ordered = [...occupants].sort(
    (a, b) => a.arrivedAt - b.arrivedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const parked = new Map(
    ordered.map((occupant) => [occupant.key, isParkedOnApron(occupant, now, parkedAfterMinutes)]),
  );

  /** This airline's contract on a stand, or null when it holds nothing there. */
  const contractOf = (stand: ApronStandFacts, airlineId: string): GateContract | null => {
    let best: GateContract | null = null;
    for (const holder of stand.holders) {
      if (holder.airlineId !== airlineId) continue;
      if (best === null || contractRank(holder.contract) < contractRank(best)) {
        best = holder.contract;
      }
    }
    return best;
  };

  /** The free stand this step would give this aeroplane, or null. */
  const candidate = (occupant: ApronOccupantFacts, step: Step): string | null => {
    let best: { position: string; rank: number; index: number } | null = null;
    for (const [index, stand] of stands.entries()) {
      if (stand.kind !== step.kind || taken.has(stand.position)) continue;
      let rank: number;
      if (step.whose === 'own') {
        const contract = contractOf(stand, occupant.airlineId);
        if (contract === null) continue;
        rank = contractRank(contract);
      } else {
        if (stand.holders.length > 0) continue;
        rank = 0;
      }
      if (best === null || rank < best.rank || (rank === best.rank && index < best.index)) {
        best = { position: stand.position, rank, index };
      }
    }
    return best?.position ?? null;
  };

  const place = (occupant: ApronOccupantFacts, position: string): void => {
    taken.add(position);
    placed.set(occupant.key, position);
  };

  // Pass 1: the stand M7-06's own measurement already puts this turn on — when
  // it is still one of the airline's own turn stands and the aeroplane is turning.
  for (const occupant of ordered) {
    if (occupant.measuredPosition === null || parked.get(occupant.key) === true) continue;
    const found = byPosition.get(occupant.measuredPosition);
    if (found === undefined || taken.has(found.stand.position)) continue;
    if (found.stand.kind !== 'contact_gate' && found.stand.kind !== 'remote_stand') continue;
    if (contractOf(found.stand, occupant.airlineId) === null) continue;
    place(occupant, found.stand.position);
  }

  // Pass 2: every airline onto its own stands, before any walk-up is placed.
  // Pass 3: whoever is left, onto the stands nobody holds.
  for (const whose of ['own', 'pool'] as const) {
    for (const occupant of ordered) {
      if (placed.has(occupant.key)) continue;
      const steps = stepsFor(occupant, parked.get(occupant.key) === true);
      for (const step of steps.filter((it) => it.whose === whose)) {
        const position = candidate(occupant, step);
        if (position !== null) {
          place(occupant, position);
          break;
        }
      }
    }
  }

  for (const occupant of ordered) {
    if (!placed.has(occupant.key)) placed.set(occupant.key, null);
  }
  return placed;
}

/* -- How big a sprite to draw ------------------------------------------------ */

/** The catalogue facts {@link apronAircraftSize} reads. */
export interface ApronTypeFacts {
  class: AircraftClass;
  family: string;
  wingspanCode: WingspanCode;
}

function sizeOfPassengerClass(aircraftClass: AircraftClass): ApronAircraftSize | null {
  switch (aircraftClass) {
    case 'turboprop_regional':
    case 'regional_jet':
      return 'regional';
    case 'narrowbody':
      return 'narrowbody';
    case 'widebody':
    case 'widebody_ulh':
      return 'widebody';
    case 'freighter':
      return null;
  }
}

/**
 * Which of the map's three sprites an aircraft type is drawn as.
 *
 * **The catalogue's class, because it already says it.** `turboprop_regional`
 * and `regional_jet` are regional, `narrowbody` is narrowbody, `widebody` and
 * `widebody_ulh` are widebody. Wingspan code alone cannot do this job: the ATR
 * 72, the E190-E2 and the A320neo are all ICAO code C, and the whole point of a
 * regional sprite is to tell the first two from the third.
 *
 * **A freighter is drawn as its passenger sibling.** `freighter` names a role
 * rather than a size — the 777F is a widebody and the ATR 72-600F is a
 * turboprop — so it takes the size of a passenger type in the same family in the
 * same catalogue. A freighter with no passenger sibling (the 747-8F, in v1)
 * falls back to its wingspan code: D and above is a widebody stand's code, C is
 * a narrowbody's, and anything smaller is regional.
 */
export function apronAircraftSize(
  type: ApronTypeFacts,
  catalogue: readonly Pick<ApronTypeFacts, 'class' | 'family'>[],
): ApronAircraftSize {
  const own = sizeOfPassengerClass(type.class);
  if (own !== null) return own;

  for (const sibling of catalogue) {
    if (sibling.family !== type.family) continue;
    const size = sizeOfPassengerClass(sibling.class);
    if (size !== null) return size;
  }

  if (type.wingspanCode === 'A' || type.wingspanCode === 'B') return 'regional';
  if (type.wingspanCode === 'C') return 'narrowbody';
  return 'widebody';
}

/* -- Runways ----------------------------------------------------------------- */

/** One end's designator: two digits and an optional parallel letter, `09`, `18L`. */
const RUNWAY_END = /^(\d{1,2})[LCR]?$/;
/** A helipad's designator: `H1`, `H12`. Not a runway, and not drawn as one. */
const HELIPAD_END = /^H\d*$/;

/** True when every end of the identifier names a helipad. */
export function isHelipadIdentifier(identifier: string): boolean {
  const ends = identifier
    .toUpperCase()
    .split('/')
    .map((end) => end.trim())
    .filter((end) => end.length > 0);
  return ends.length > 0 && ends.every((end) => HELIPAD_END.test(end));
}

/**
 * The heading the map draws a runway at, from its designator alone.
 *
 * The airport import carries no heading column — only the identifier, `09/27`
 * or `18L/36R`. A designator **is** a bearing: the runway's magnetic heading,
 * divided by ten and rounded. So the lower-numbered end times ten gives `09/27`
 * → 90° and `18L/36R` → 180°, which is a **schematic orientation, rounded to
 * 10°, and magnetic rather than true** — right for a stylised map, wrong for
 * anything that navigates. Null when no end is numeric (`N/S`, a closed strip
 * named by letter), because a guessed orientation would draw a runway the airport
 * does not have.
 */
export function runwayHeadingDegrees(identifier: string): number | null {
  const numbers = identifier
    .toUpperCase()
    .split('/')
    .map((end) => RUNWAY_END.exec(end.trim()))
    .flatMap((match) => (match === null ? [] : [Number(match[1])]))
    .filter((n) => n >= 1 && n <= 36);
  if (numbers.length === 0) return null;
  return (Math.min(...numbers) * 10) % 360;
}
