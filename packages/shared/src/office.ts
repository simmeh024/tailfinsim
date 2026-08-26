import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/**
 * The head office (M5-04, design doc §9.1).
 *
 * §9.1's rule, and the shape of this whole file: **senior hires are capability
 * unlocks and automation, not stat bonuses.** Each role's effect is a concrete
 * thing the hire takes off the player's hands, and the only role that changes
 * what the *simulation* will permit is Safety & Compliance — long-haul, ETOPS
 * and international authority are unreachable until that seat is filled.
 *
 * This is the wire and balance contract both the server and the client read.
 * The candidate *market* — the named faces, their portraits and their traits —
 * lives client-side for now; what crosses the boundary is which seat an airline
 * has filled, what it costs a month, and which seat gates authority.
 */

/** The six MVP office seats. */
export const OfficeRole = z.enum([
  'route-planner',
  'revenue-manager',
  'ops-controller',
  'chief-pilot',
  'ground-ops',
  'safety-compliance',
]);
export type OfficeRole = z.infer<typeof OfficeRole>;

export interface OfficeRoleDefinition {
  role: OfficeRole;
  /** The seat's name. */
  title: string;
  /** The concrete §9.1 capability filling the seat unlocks. Never a percentage. */
  unlock: string;
  /**
   * Salary per game month, in integer minor units. The seat's, not the
   * candidate's: candidates compete on trait, not price (poaching and price
   * negotiation are §9.1's post-MVP). A balance number — it will move into the
   * economy config when the office economy is tuned, and until then it lives
   * here so the server that bills it and the client that shows it read one value.
   */
  monthlySalaryMinor: number;
  /**
   * Whether filling this seat is what grants extended operating authority —
   * long-haul, ETOPS and international. Only Safety & Compliance does, and that
   * is M5-04's load-bearing acceptance criterion rather than flavour.
   */
  gatesExtendedAuthority: boolean;
}

/**
 * The seats, in §9.1's order. The one source of truth for a role's salary and
 * its unlock; the server bills from `monthlySalaryMinor` and gates from
 * `gatesExtendedAuthority`, and the client renders both.
 */
export const OFFICE_ROLES: Readonly<Record<OfficeRole, OfficeRoleDefinition>> = {
  'route-planner': {
    role: 'route-planner',
    title: 'Route Planner',
    unlock: 'Surfaces ranked route opportunities with demand and competition analysis.',
    monthlySalaryMinor: 1_800_000,
    gatesExtendedAuthority: false,
  },
  'revenue-manager': {
    role: 'revenue-manager',
    title: 'Revenue Manager',
    unlock: 'Unlocks automated fare rules — set a policy and they run it per flight.',
    monthlySalaryMinor: 2_000_000,
    gatesExtendedAuthority: false,
  },
  'ops-controller': {
    role: 'ops-controller',
    title: 'Ops Controller',
    unlock:
      'Runs disruption by your standing policy while you are offline — swap, delay or cancel to the rules you set.',
    monthlySalaryMinor: 2_600_000,
    gatesExtendedAuthority: false,
  },
  'chief-pilot': {
    role: 'chief-pilot',
    title: 'Chief Pilot',
    unlock:
      'Unlocks training programmes and type-rating conversions, and raises the fatigue safety margin.',
    monthlySalaryMinor: 2_800_000,
    gatesExtendedAuthority: false,
  },
  'ground-ops': {
    role: 'ground-ops',
    title: 'Head of Ground Ops',
    unlock: 'Unlocks self-handling and improves the turnaround baseline across your network.',
    monthlySalaryMinor: 2_400_000,
    gatesExtendedAuthority: false,
  },
  'safety-compliance': {
    role: 'safety-compliance',
    title: 'Safety & Compliance',
    unlock: 'Required for long-haul and ETOPS authority and international rights.',
    monthlySalaryMinor: 3_000_000,
    gatesExtendedAuthority: true,
  },
};

/** The seats in canonical order — for iterating without depending on object key order. */
export const OFFICE_ROLE_ORDER: readonly OfficeRole[] = [
  'route-planner',
  'revenue-manager',
  'ops-controller',
  'chief-pilot',
  'ground-ops',
  'safety-compliance',
];

/** True for the one seat that unlocks extended operating authority. */
export function roleGatesExtendedAuthority(role: OfficeRole): boolean {
  return OFFICE_ROLES[role].gatesExtendedAuthority;
}

/** The role a player must fill to reach long-haul, ETOPS and international authority. */
export const EXTENDED_AUTHORITY_ROLE: OfficeRole = 'safety-compliance';

/**
 * The neutral office seats an airline unlocks by expanding its headquarters
 * (§9.1, post-MVP made real).
 *
 * A neutral seat is **not** one of the six roles: it is a flexible office any
 * candidate can occupy, and it grants **no role-gated capability** — it is extra
 * staffed capacity, billed like any other seat. Long-haul authority still comes
 * only from the real {@link EXTENDED_AUTHORITY_ROLE} seat, never from a neutral
 * one, so a duplicate cannot smuggle an unlock in the side door.
 */
export const NEUTRAL_OFFICE_SEATS = ['neutral-1', 'neutral-2', 'neutral-3', 'neutral-4'] as const;
export type NeutralOfficeSeat = (typeof NEUTRAL_OFFICE_SEATS)[number];

/** Where a hire sits: one of the six role seats, or a neutral expansion seat. */
export const OfficeSeatId = z.enum([
  'route-planner',
  'revenue-manager',
  'ops-controller',
  'chief-pilot',
  'ground-ops',
  'safety-compliance',
  'neutral-1',
  'neutral-2',
  'neutral-3',
  'neutral-4',
]);
export type OfficeSeatId = z.infer<typeof OfficeSeatId>;

/** True for the flexible expansion seats — the ones with no fixed role. */
export function isNeutralSeat(seat: OfficeSeatId): seat is NeutralOfficeSeat {
  return (NEUTRAL_OFFICE_SEATS as readonly string[]).includes(seat);
}

/** The six role seats every headquarters starts with, before any expansion. */
export const HEADQUARTERS_BASE_SEATS = OFFICE_ROLE_ORDER.length;

/**
 * Headquarters expansion tiers (§9.1, "Expand Headquarters").
 *
 * Each purchase unlocks two more neutral seats for a one-time cost, so a player
 * grows from six offices to eight to ten. `neutralSeats` is the *cumulative*
 * count unlocked after buying the tier, so it doubles as the key for "which tier
 * is next": the next tier is the first whose `neutralSeats` exceeds what the
 * airline already holds. Ten is the ceiling.
 *
 * The costs are balance numbers — like the seat salaries, they live here until
 * the office economy moves into the economy config, and the amounts are integer
 * minor units (so $10,000,000 is 1_000_000_000).
 */
export interface HeadquartersExpansionTier {
  /** Cumulative neutral seats unlocked once this tier is bought. */
  neutralSeats: number;
  /** Total offices — base six plus neutral — after this tier. */
  totalSeats: number;
  /** One-time cost in integer minor units. */
  costMinor: number;
}

export const HEADQUARTERS_EXPANSION_TIERS: readonly HeadquartersExpansionTier[] = [
  { neutralSeats: 2, totalSeats: 8, costMinor: 1_000_000_000 },
  { neutralSeats: 4, totalSeats: 10, costMinor: 2_500_000_000 },
];

/** The most neutral seats a headquarters can ever hold. */
export const MAX_NEUTRAL_OFFICE_SEATS =
  HEADQUARTERS_EXPANSION_TIERS[HEADQUARTERS_EXPANSION_TIERS.length - 1]?.neutralSeats ?? 0;

/** The next tier an airline with `neutralSeats` unlocked can buy, or null if maxed. */
export function nextExpansionTier(neutralSeats: number): HeadquartersExpansionTier | null {
  return HEADQUARTERS_EXPANSION_TIERS.find((tier) => tier.neutralSeats > neutralSeats) ?? null;
}

/** Which neutral seats are live at a given unlock count, in order. */
export function unlockedNeutralSeats(neutralSeats: number): readonly NeutralOfficeSeat[] {
  return NEUTRAL_OFFICE_SEATS.slice(
    0,
    Math.max(0, Math.min(neutralSeats, MAX_NEUTRAL_OFFICE_SEATS)),
  );
}

/**
 * The distance beyond which a route needs extended authority, in nautical miles.
 *
 * A balance number, and deliberately reachable by the reference narrowbody
 * `open-route.ts` flies (its range admits sectors to roughly 2,800 nm) so the
 * gate is exercisable today rather than only once wide-body types exist. It will
 * move into the economy config with the rest of the office economy.
 */
export const LONG_HAUL_THRESHOLD_NM = 2_200;

/** One filled seat, as the client sees it. */
export const OfficeHire = z.object({
  /** Where the person sits — a role seat, or a neutral expansion seat. */
  seat: OfficeSeatId,
  /** The candidate hired into the seat — opaque to the server, for the client to render. */
  candidateId: z.string().min(1),
  candidateName: z.string().min(1),
  monthlySalaryMinor: z.number().int().nonnegative(),
  hiredAt: Timestamp,
});
export type OfficeHire = z.infer<typeof OfficeHire>;

/** The next headquarters expansion an airline can buy, as the client sees it. */
export const OfficeExpansionOffer = z.object({
  /** Seats this purchase adds (always two). */
  addsSeats: z.number().int().positive(),
  /** Total offices once bought — 8 or 10. */
  totalSeats: z.number().int().positive(),
  /** One-time cost in integer minor units. */
  costMinor: z.number().int().nonnegative(),
});
export type OfficeExpansionOffer = z.infer<typeof OfficeExpansionOffer>;

/** `GET /api/office` — every seat this airline has filled, and its expansion standing. */
export const OfficeStateResponse = z.object({
  hires: z.array(OfficeHire),
  /** Convenience for the client: whether long-haul/ETOPS/international authority is unlocked. */
  hasExtendedAuthority: z.boolean(),
  /** Neutral expansion seats unlocked so far — 0, 2 or 4. */
  neutralSeats: z.number().int().nonnegative(),
  /** The next expansion the airline can buy, or null once the ten-office ceiling is reached. */
  nextExpansion: OfficeExpansionOffer.nullable(),
});
export type OfficeStateResponse = z.infer<typeof OfficeStateResponse>;

/** `POST /api/office/hires` — hire a candidate into a seat, replacing any incumbent. */
export const HireOfficeRequest = z.object({
  /** The seat to fill. A neutral seat must already be unlocked by expansion. */
  seat: OfficeSeatId,
  candidateId: z.string().min(1),
  candidateName: z.string().min(1),
  /**
   * The candidate's role. It sets the salary billed, and for a role seat it must
   * equal the seat — the server refuses a mismatch. A neutral seat accepts any role.
   */
  candidateRole: OfficeRole,
});
export type HireOfficeRequest = z.infer<typeof HireOfficeRequest>;

/** The airline id is never on the wire — ownership is resolved from the session (AIR-05). */
export const OfficeAirlineId = Uuid;
