import { z } from 'zod';

import { AirportTier } from './airport';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * Gates and stands — the wire contract (M7-06, App. B.6, App. B.8).
 *
 * A slot is permission to move at a time; a gate is somewhere to park. App. B.8
 * sets them side by side and warns that acquiring one without the other is *"a
 * classic new-player mistake and the UI should warn about it loudly — not prevent
 * it"*. `slots.ts` is the other half of that pair; this is the second scarce
 * resource, and unlike a slot it is **leased for a term and billed**.
 *
 * ## The vocabularies live here
 *
 * `StandKind` and `GateContract` are declared in this package rather than in
 * `@tailfin/sim`, for the reason `HandlerGrade` is: the economy config keys off
 * both, the database enum mirrors both, and the client renders both. One
 * declaration that every layer imports is what keeps a new stand kind from
 * arriving in four places with three spellings.
 *
 * ## Every price on these types is server-decided
 *
 * Same discipline as `hub.ts`. The client never computes what a stand costs and
 * never sends a price it invented; it is told, it shows the figure, and it echoes
 * it back on the lease so the server can refuse a stale one.
 */

/**
 * App. B.6's five stand types.
 *
 * Only the first two are passenger turnarounds, and only they change how long a
 * turn takes — a remote stand costs the +10–12 minutes of bussing that
 * `computeTurnaround` has priced since M2-04 and nothing could trigger until
 * there were stands to hold. The other three are holdings without a turn.
 */
export const StandKind = z.enum([
  'contact_gate',
  'remote_stand',
  'overnight_parking',
  'cargo_stand',
  'maintenance_stand',
]);
export type StandKind = z.infer<typeof StandKind>;
export const STAND_KINDS = StandKind.options;

/**
 * App. B.6's three contracts — *"where the shared-world conflict lives"*.
 *
 * `common_use` is not a lease: it is a per-turn fee, first come, bumpable at
 * peak, and it reserves nothing. `preferential` is an annual lease with priority.
 * `exclusive` is an annual lease at roughly 2.5× that **denies the stand to every
 * other airline**, which is the only one of the three that is visible to anyone
 * but its holder.
 */
export const GateContract = z.enum(['common_use', 'preferential', 'exclusive']);
export type GateContract = z.infer<typeof GateContract>;
export const GATE_CONTRACTS = GateContract.options;

/**
 * One airline holding one stand, as every airline at the airport sees it.
 *
 * Named rather than counted, for the reason `SlotHolder` gives: App. B.6 makes
 * holding gates you barely use *"a legitimate blocking strategy"*, and a blocking
 * strategy nobody can attribute is just a closed door. App. B.7 puts it more
 * plainly still — *"you can see exactly who holds what, which makes gate
 * competition legible and personal"*.
 *
 * Identity only. Name and codes are already public on every competing airline;
 * what the holding cost them is not disclosed.
 */
export const StandHolder = z.object({
  airlineId: Uuid,
  name: z.string().min(1),
  iataCode: z.string().nullable(),
  contract: GateContract,
  /** True for the airline asking. Saves the client a comparison it would get wrong once. */
  isYou: z.boolean(),
});
export type StandHolder = z.infer<typeof StandHolder>;

/** How busy one stand you hold actually was. */
export const StandUtilisationView = z.object({
  /** Turns worked from this stand across the sampled day. */
  turns: z.number().int().nonnegative(),
  /** Minutes it was occupied inside the 06:00–23:00 operating day. */
  occupiedMinutes: z.number().int().nonnegative(),
  /** `occupiedMinutes` over the operating day, 0–1. App. B.6's 12%. */
  fraction: z.number().min(0).max(1),
  /**
   * True when this stand is below the utilisation floor and could be withdrawn.
   *
   * App. B.6 counters gate hoarding with *"a use-it-or-lose-it utilisation floor,
   * same principle as slots"*. The client shows it as a warning rather than as a
   * countdown, because the floor is measured over a window and a stand that is
   * idle today is not yet lost.
   */
  belowFloor: z.boolean(),
});
export type StandUtilisationView = z.infer<typeof StandUtilisationView>;

/** One physical stand at one airport, and where it stands for you. */
export const AirportStand = z.object({
  /** Stable within the airport, and what a lease addresses: `B12`, `R4`, `N7`. */
  position: z.string().min(1),
  kind: StandKind,
  /** Who holds it. Empty when nobody does. */
  holders: z.array(StandHolder),
  /** Your own contract here, or null when you hold nothing. */
  yourContract: GateContract.nullable(),
  /**
   * Whether an exclusive lease has taken this stand off the board.
   *
   * True for the holder as well as for everyone else — an exclusive stand is
   * closed to the world, and the holder should see that they are what closed it.
   */
  exclusivelyHeld: z.boolean(),
  /** True when you could lease it: not exclusively held by somebody else. */
  available: z.boolean(),
  /** Your stand's day, or null when you do not hold it. */
  utilisation: StandUtilisationView.nullable(),
  /** What an annual lease here costs, by contract. `common_use` is zero. */
  annualFeeMinor: z.object({
    common_use: MinorUnits.nonnegative(),
    preferential: MinorUnits.nonnegative(),
    exclusive: MinorUnits.nonnegative(),
  }),
  /** What one walk-up turn costs instead of leasing. */
  commonUseTurnFeeMinor: MinorUnits.nonnegative(),
});
export type AirportStand = z.infer<typeof AirportStand>;

/**
 * What App. B.6's formula says this airline's operation needs here.
 *
 * ```
 * ContactGates = ceil( P95(concurrent aircraft in turnaround) × 1.2 )
 * ```
 *
 * Published rather than merely enforced, because the whole lesson of the worked
 * example is that a first hub pays for a gate it uses 12% of the time and *"the
 * fix is more rotations, not more gates"*. A player who is only told they are
 * short of gates learns the opposite of that.
 */
export const StandRequirement = z.object({
  /** Contact gates the schedule needs. */
  contactGates: z.number().int().nonnegative(),
  /** Contact gates you hold on any contract. */
  contactGatesHeld: z.number().int().nonnegative(),
  /** Overnight positions the schedule needs. */
  overnightPositions: z.number().int().nonnegative(),
  /** Overnight positions you hold. */
  overnightPositionsHeld: z.number().int().nonnegative(),
  /** The percentile itself, before the buffer — so the arithmetic is visible. */
  percentileConcurrency: z.number().nonnegative(),
  /** The busiest instant of the sampled day. */
  peakConcurrency: z.number().int().nonnegative(),
  /** Turns the requirement was computed from. Zero means it says nothing yet. */
  turns: z.number().int().nonnegative(),
  /**
   * The game day the requirement was sampled from, or null when nothing flew.
   *
   * A requirement is read off real flights, and only the **worker** produces
   * those. On a node with no worker this is null for ever and the requirement is
   * zero — which reads as an airline that needs no gates rather than as a missing
   * process, so the client says which it is.
   */
  sampledGameDate: Timestamp.nullable(),
});
export type StandRequirement = z.infer<typeof StandRequirement>;

/**
 * `GET /api/airports/:icao/gates` — one airport's stand picture for you.
 *
 * Unlike a slot, a stand exists at every airport: App. B.8's scarcity row says
 * slots are *"Level 3 airports only"* and gates are scarce *"anywhere popular"*.
 * So there is no `coordinated` flag here and no empty case — an airport with one
 * apron has few stands, and few is the answer.
 */
export const AirportGatesResponse = z.object({
  icao: z.string().min(1),
  name: z.string(),
  tier: AirportTier,
  stands: z.array(AirportStand),
  requirement: StandRequirement,
  /** Your leases here, per month — what this airport bills you. */
  monthlyFeeMinor: MinorUnits.nonnegative(),
  /**
   * Turns a month a lease needs to beat paying per turn, for a contact gate here.
   *
   * §14 decision support, never a gate. It is the number that makes "you are
   * paying for a gate you use 12% of the time" actionable rather than merely
   * true.
   */
  leaseBreakevenTurnsPerMonth: z.number().nonnegative(),
});
export type AirportGatesResponse = z.infer<typeof AirportGatesResponse>;

/**
 * Take a stand.
 *
 * `expectedAnnualFeeMinor` is echoed back for the reason {@link PurchaseHubRequest}
 * echoes a hub price: a retune or a rival's exclusive lease can move what is on
 * offer between the page rendering and the button being pressed, and an airline
 * that is charged a figure it never saw has not agreed to anything.
 */
export const LeaseStandRequest = z
  .object({
    position: z.string().min(1).max(16),
    contract: GateContract,
    expectedAnnualFeeMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type LeaseStandRequest = z.infer<typeof LeaseStandRequest>;

/** Why leasing a stand was refused (M7-06). */
export const StandLeaseProblem = z.enum([
  'unknown_stand',
  /** Somebody else holds it exclusively — App. B.6's denial, working. */
  'exclusively_held',
  /** You want it exclusively and somebody else is already on it. */
  'contested',
  /** A common-use stand is paid per turn; there is nothing to lease. */
  'not_leasable',
  'fee_changed',
]);
export type StandLeaseProblem = z.infer<typeof StandLeaseProblem>;

/** Both writes answer with the whole airport, so a client never has to re-fetch. */
export const GateMutationResponse = AirportGatesResponse;
export type GateMutationResponse = z.infer<typeof GateMutationResponse>;
