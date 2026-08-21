import { z } from 'zod';

import { AirportIcaoCode, MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * NPC carriers, as a wire contract (M3-12, §24).
 *
 * §24 lists AI carriers as MVP-blocking, and says why in one line: *"500 players
 * cannot populate 4,000 airports. Without AI incumbents the world is empty and
 * the demand model has nothing to compete against."*
 *
 * The governing rule is that an NPC is **an airline**, not a special kind of
 * thing. Same table, same constraints, same fare floor, same demand model, same
 * economy config. What is special is only that a scheduled job decides its
 * fares and its network instead of a person.
 */

/** Who runs an airline. */
export const AirlineKind = z.enum(['player', 'npc']);
export type AirlineKind = z.infer<typeof AirlineKind>;

/**
 * The four archetypes §24 names.
 *
 * They exist to produce visibly different behaviour in App. A.3's logit rather
 * than as flavour: a flag carrier and a low-cost carrier on the same city pair
 * should lose to each other in *different segments*, which is the property the
 * segmented model exists to express.
 */
export const NpcArchetype = z.enum(['flag', 'lcc', 'regional', 'charter']);
export type NpcArchetype = z.infer<typeof NpcArchetype>;

export const NPC_ARCHETYPES: readonly NpcArchetype[] = ['flag', 'lcc', 'regional', 'charter'];

/** Player-facing archetype names. The enum values are identifiers, not labels. */
export const NPC_ARCHETYPE_LABEL: Record<NpcArchetype, string> = {
  flag: 'Flag carrier',
  lcc: 'Low-cost carrier',
  regional: 'Regional',
  charter: 'Charter',
};

export const NpcDecisionKind = z.enum([
  'route_opened',
  'route_closed',
  'fare_changed',
  'entry_declined',
]);
export type NpcDecisionKind = z.infer<typeof NpcDecisionKind>;

/**
 * The figures a decision rested on.
 *
 * Every field is optional because the four decision kinds rest on different
 * numbers, and a basis that padded the unused ones with zeros would read as
 * *"this NPC entered a market it believed had no passengers"*. Absent means the
 * figure was not part of this decision.
 */
export const NpcDecisionBasis = z
  .object({
    /** Daily passengers in the market, from `demand_pool`. */
    dailyPassengers: z.number().nonnegative().optional(),
    /** Operators already selling the pair, the NPC excluded. */
    incumbents: z.number().int().nonnegative().optional(),
    /** Per-seat variable cost the fare was drawn against (A.10). */
    variableCostPerSeatMinor: MinorUnits.optional(),
    /** A.10's floor for this route — the fare below which nothing may be sold. */
    floorMinor: MinorUnits.optional(),
    /** The mean fare across operators selling this cabin, A.3's `PriceRel` denominator. */
    marketFareMinor: MinorUnits.optional(),
    fareBeforeMinor: MinorUnits.optional(),
    fareAfterMinor: MinorUnits.optional(),
    /** Estimated margin per seat, as a fraction of the fare. */
    estimatedMargin: z.number().optional(),
    /** Consecutive reviews the route has been judged a loss-maker. */
    lossReviews: z.number().int().nonnegative().optional(),
    greatCircleNm: z.number().nonnegative().optional(),
  })
  .strict();
export type NpcDecisionBasis = z.infer<typeof NpcDecisionBasis>;

/** One decision, as the admin console lists it. */
export const AdminNpcDecision = z.object({
  id: Uuid,
  airlineId: Uuid,
  airlineName: z.string().min(1),
  airlineIataCode: z.string().min(1),
  archetype: NpcArchetype,
  /** **Game time** — the instant the world thinks this happened. */
  decidedAt: Timestamp,
  /** Real time, so a decision can be lined up against a worker log line. */
  recordedAt: Timestamp,
  kind: NpcDecisionKind,
  originIcao: AirportIcaoCode.nullable(),
  destinationIcao: AirportIcaoCode.nullable(),
  basis: NpcDecisionBasis,
  reason: z.string().min(1),
  /** The economy version it was judged under, so an old decision stays explicable. */
  economyConfigVersion: z.string().min(1),
});
export type AdminNpcDecision = z.infer<typeof AdminNpcDecision>;

/** One NPC carrier, as the admin console lists it. */
export const AdminNpcCarrier = z.object({
  airlineId: Uuid,
  name: z.string().min(1),
  iataCode: z.string().min(1),
  icaoCode: z.string().min(1),
  archetype: NpcArchetype,
  baseCountry: z.string().min(1),
  /** Where it flies from. Derived from its network, not stored separately. */
  hubIcao: AirportIcaoCode.nullable(),
  routes: z.number().int().nonnegative(),
  cashMinor: MinorUnits,
  reputation: z.number().min(0).max(1),
});
export type AdminNpcCarrier = z.infer<typeof AdminNpcCarrier>;

/** `GET /api/admin/worlds/:worldId/npc`. */
export const AdminNpcResponse = z.object({
  carriers: z.array(AdminNpcCarrier),
  /** Newest first. Bounded; this table grows without limit. */
  decisions: z.array(AdminNpcDecision),
  /**
   * Whether this world has NPC carriers at all.
   *
   * Distinct from an empty list for the same reason PX-09 distinguishes an
   * unknown market from a bad one: a world that was never seeded and a world
   * whose NPCs have all exited are different problems.
   */
  seeded: z.boolean(),
});
export type AdminNpcResponse = z.infer<typeof AdminNpcResponse>;
