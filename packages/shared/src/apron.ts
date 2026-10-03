import { z } from 'zod';

import { AirportTier } from './airport';
import { AirportGatesResponse, StandUtilisationView } from './gates';
import { Timestamp, Uuid } from './primitives';

/**
 * The airport map — the wire contract (M7-07, App. B.7, §H.2).
 *
 * > *"Zoom from the world map into any airport you operate at. A clean 2D
 * > schematic — accurate in topology, stylised in geometry, in the house design
 * > language."*
 *
 * App. B.7 calls it *"the second place, after the livery builder, where your
 * airline becomes a visible object rather than a spreadsheet."* Everything on it
 * is drawn from facts the game already holds: the apron and who holds each stand
 * (M7-06), the aircraft on the ground and the flights that brought them, and the
 * runways from the airport import. Nothing here is a mechanic of its own — the
 * map is a way of **seeing** the gates, slots and turnarounds that already decide
 * money, and it must never show a state the rest of the game disagrees with.
 *
 * ## What is public, and why
 *
 * The same projection the world map already makes: every carrier's aircraft is
 * visible with its airline, colour, registration and type (`WorldMapFlight`), and
 * who holds each stand is public by M7-06's decision — *"you can see exactly who
 * holds what, which makes gate competition legible and personal."* What a rival's
 * lease cost, and how busy a rival's stands are, stay private: utilisation and
 * the day's rotation are sent for **your** stands only.
 */

// ---------------------------------------------------------------------------
// The turnaround, as the map draws it
// ---------------------------------------------------------------------------

/** App. B.7's five progress rings, in the order a turn works through them. */
export const TurnaroundPhase = z.enum(['bags', 'cleaning', 'catering', 'fuelling', 'boarding']);
export type TurnaroundPhase = z.infer<typeof TurnaroundPhase>;
export const TURNAROUND_PHASES = TurnaroundPhase.options;

export interface TurnaroundPhaseWindow {
  phase: TurnaroundPhase;
  label: string;
  /** Start and end as fractions of the whole turn, on-blocks (0) to off-blocks (1). */
  from: number;
  to: number;
}

/**
 * When each of the five ground processes runs, as a share of the turn.
 *
 * **Presentation, not simulation.** `computeTurnaround` decides how long a turn
 * takes — the handler, the stand, the cabin, the boosts — and the game has never
 * modelled the five processes inside it separately; inventing per-process
 * durations would be a second turnaround model that could disagree with the one
 * that bills. So the map shares out the real, modelled turn along the standard
 * ground-handling sequence: bags come off and go on across the first half,
 * cleaning and catering work the cabin once it is empty, fuelling runs alongside
 * them, and boarding closes the turn. Every ring therefore completes exactly when
 * the real turn does, however long the real turn is.
 *
 * Design rather than balance, which is why it is here and not in the economy
 * config: moving catering is a redesign of a picture, not a retune of a price.
 */
export const TURNAROUND_PHASE_WINDOWS: readonly TurnaroundPhaseWindow[] = [
  { phase: 'bags', label: 'Bags', from: 0, to: 0.5 },
  { phase: 'cleaning', label: 'Cleaning', from: 0.1, to: 0.45 },
  { phase: 'catering', label: 'Catering', from: 0.15, to: 0.5 },
  { phase: 'fuelling', label: 'Fuelling', from: 0.2, to: 0.6 },
  { phase: 'boarding', label: 'Boarding', from: 0.55, to: 0.95 },
];

/**
 * How far each process has got, 0–1, at a game instant.
 *
 * `departsAt` null — an aeroplane with no next departure scheduled from here —
 * reads as a turn that has finished: it is parked, not being turned.
 */
export function turnaroundProgress(
  arrivedAt: Date,
  departsAt: Date | null,
  now: Date,
): Record<TurnaroundPhase, number> {
  const progress = {} as Record<TurnaroundPhase, number>;
  const span = departsAt === null ? 0 : departsAt.getTime() - arrivedAt.getTime();
  const elapsed = span <= 0 ? 1 : (now.getTime() - arrivedAt.getTime()) / span;
  for (const window of TURNAROUND_PHASE_WINDOWS) {
    const share = (elapsed - window.from) / (window.to - window.from);
    progress[window.phase] = Math.min(1, Math.max(0, share));
  }
  return progress;
}

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/** An airline as the apron shows it: identity and colour, public like the world map's. */
export const ApronAirline = z
  .object({
    airlineId: Uuid,
    name: z.string().min(1),
    iataCode: z.string().nullable(),
    /** `airlineMapColour` — the colour its planes and routes already carry on the world map. */
    colour: z.string().regex(/^#[0-9a-f]{6}$/),
    /** True for the airline asking. */
    isYou: z.boolean(),
  })
  .strict();
export type ApronAirline = z.infer<typeof ApronAirline>;

/** How big a sprite to draw. From the catalogue, never from the client's guess. */
export const ApronAircraftSize = z.enum(['regional', 'narrowbody', 'widebody']);
export type ApronAircraftSize = z.infer<typeof ApronAircraftSize>;

/**
 * One aeroplane on the ground at this airport right now.
 *
 * On the ground means: its last flight **arrived here** and it has not departed
 * again. `standPosition` is the stand the map draws it on — assigned by the
 * server, deterministically, from the stands its airline holds here and then the
 * common pool, because the game stores no gate assignment (App. B.7 files
 * *"gate assignment as an optimisation puzzle"* under post-MVP). Null when
 * nothing fits; the map parks it on the remote apron.
 */
export const ApronAircraft = z
  .object({
    /** Stable for the stay: the id of the flight that brought it, as the world map exposes it. */
    key: z.string().min(1),
    airline: ApronAirline,
    registration: z.string().nullable(),
    typeDesignation: z.string().nullable(),
    size: ApronAircraftSize,
    standPosition: z.string().nullable(),
    /** Game time it came on blocks. */
    arrivedAt: Timestamp,
    /** Game time its next departure from here is due, or null when none is scheduled. */
    departsAt: Timestamp.nullable(),
    /** Where it flies next, when it has a next departure. */
    nextDestinationIcao: z.string().nullable(),
    /** Yours only: the departing flight, for the flight panel. Null for every rival. */
    flightId: Uuid.nullable(),
  })
  .strict();
export type ApronAircraft = z.infer<typeof ApronAircraft>;

/** A runway from the airport import, enough to draw it. */
export const ApronRunway = z
  .object({
    /** `09/27`, or whichever ends the import names. */
    ident: z.string().min(1),
    lengthFt: z.number().int().positive().nullable(),
    widthFt: z.number().int().positive().nullable(),
    /**
     * The lower-numbered end's designator × 10, degrees: `09/27` → 90. The import
     * carries no surveyed heading, so this is the magnetic bearing rounded to 10° —
     * enough to orient a schematic, and stated as such. Null when the designator is
     * not numeric.
     */
    headingDeg: z.number().min(0).lt(360).nullable(),
  })
  .strict();
export type ApronRunway = z.infer<typeof ApronRunway>;

/** A landing or a take-off a few game minutes either side of now — *"runways with live movements"*. */
export const ApronMovement = z
  .object({
    kind: z.enum(['arrival', 'departure']),
    /** Game time it touched down or lifted off, or is due to. */
    at: Timestamp,
    airline: ApronAirline,
    typeDesignation: z.string().nullable(),
    /** The other end of the flight. */
    otherIcao: z.string().min(1),
  })
  .strict();
export type ApronMovement = z.infer<typeof ApronMovement>;

/** One turn worked from one of your stands across the sampled day. */
export const StandTurn = z
  .object({
    arrivedAt: Timestamp,
    departsAt: Timestamp,
    registration: z.string().nullable(),
    fromIcao: z.string().nullable(),
    toIcao: z.string().nullable(),
  })
  .strict();
export type StandTurn = z.infer<typeof StandTurn>;

/** *"Click a gate to see the day's rotation and utilisation"* — for your stands. */
export const StandDay = z
  .object({
    position: z.string().min(1),
    /** In arrival order. The same turns `utilisation` is measured from. */
    turns: z.array(StandTurn),
    utilisation: StandUtilisationView,
  })
  .strict();
export type StandDay = z.infer<typeof StandDay>;

/**
 * `GET /api/airports/:icao/apron` — the airport map's whole picture.
 *
 * `gates` is M7-06's `GET /api/airports/:icao/gates` answer, embedded unchanged,
 * so the map and the gates panel cannot disagree about who holds what or what a
 * lease costs — and leasing from the map is the existing `POST`/`DELETE` on the
 * gates route, whose response is the same shape.
 */
export const ApronResponse = z
  .object({
    icao: z.string().min(1),
    name: z.string(),
    tier: AirportTier,
    /** The world's game clock when this was read. The client advances it with `useWorldClock`. */
    gameNow: Timestamp,
    /** The airline asking, so the map can paint its gates in its own colour. */
    you: ApronAirline,
    gates: AirportGatesResponse,
    runways: z.array(ApronRunway),
    aircraft: z.array(ApronAircraft),
    movements: z.array(ApronMovement),
    /** Your stands only. A rival's rotation and utilisation are not disclosed. */
    standDays: z.array(StandDay),
  })
  .strict();
export type ApronResponse = z.infer<typeof ApronResponse>;
