import { z } from 'zod';

import { EXECUTIVE_BOOST_LEVERS, type ExecutiveBoost, type ExecutiveBoostLever } from './executive';
import { Timestamp, Uuid } from './primitives';

/**
 * The head office (M5-04, design doc §9.1).
 *
 * §9.1's rule shapes this whole file: a **seat is a capability unlock**, the same
 * for anyone who fills it, and the only role that changes what the *simulation*
 * will permit is Safety & Compliance — long-haul, ETOPS and international
 * authority are unreachable until that seat is filled. On top of the seat, the
 * §9.1 follow-up gives each *candidate* a tiny, salary-scaled **boost** of their
 * own (the "visible trait" made real) — see {@link officeSeatBoost}. The boost is
 * part of the shared contract because the worker will apply it; the portraits and
 * the flavour trait stay client-side.
 *
 * This is the wire and balance contract both the server and the client read: which
 * seat an airline has filled, what it costs a month, which seat gates authority,
 * and — keyed by candidate id — the boost that hire brings.
 */

/**
 * The office roles a hire can be priced and identified as.
 *
 * The first six are the MVP seats, each with its own fixed room. `social-media`
 * is the odd one out: it is a **specialist**, not a seat. It is listed here so a
 * specialist hire has a salary and a stable role string on the wire, but it is
 * deliberately absent from {@link OFFICE_ROLE_ORDER} (so it draws no fixed room)
 * and from {@link OfficeSeatId} (so it can never occupy a role seat — only a
 * neutral office). See {@link SOCIAL_MEDIA_SPECIALISTS}.
 */
export const OfficeRole = z.enum([
  'route-planner',
  'revenue-manager',
  'ops-controller',
  'chief-pilot',
  'ground-ops',
  'safety-compliance',
  'social-media',
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
  'social-media': {
    role: 'social-media',
    title: 'Social Media Specialist',
    unlock: 'A neutral-office specialist with a small standing edge — see the Specialist row.',
    monthlySalaryMinor: 1_500_000,
    gatesExtendedAuthority: false,
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
 * The social media specialist (§9.1, the "Specialist" row).
 *
 * A specialist is not one of the six seats and never takes a role seat: the
 * `social-media` role above exists only so a specialist hire can be *priced* and
 * *identified*, and the seat enum omits it, so the one place a specialist can sit
 * is a neutral office. Two specialists exist, each with a different standing edge;
 * a world offers **exactly one** of them, chosen once and deterministically from
 * the world id, and an airline may employ that one and no other.
 *
 * The ids are shared, not client-private, because three parties must agree on
 * them: the client roster that shows the face, the server that admits the hire,
 * and the worker that applies the edge each month.
 */
export type SocialMediaSpecialistEffect = 'reputation' | 'attractiveness';

export interface SocialMediaSpecialist {
  /** Stable id, shared by the client roster, the wire and the worker. */
  id: string;
  effect: SocialMediaSpecialistEffect;
}

export const SOCIAL_MEDIA_SPECIALISTS: readonly SocialMediaSpecialist[] = [
  { id: 'social-media-reputation', effect: 'reputation' },
  { id: 'social-media-attractiveness', effect: 'attractiveness' },
];

/** True for a candidate id that belongs to a social media specialist. */
export function isSocialMediaSpecialistId(candidateId: string): boolean {
  return SOCIAL_MEDIA_SPECIALISTS.some((specialist) => specialist.id === candidateId);
}

/** The edge a specialist id carries, or null if the id is not a specialist. */
export function socialMediaSpecialistEffect(
  candidateId: string,
): SocialMediaSpecialistEffect | null {
  return (
    SOCIAL_MEDIA_SPECIALISTS.find((specialist) => specialist.id === candidateId)?.effect ?? null
  );
}

/**
 * The one specialist a world puts on offer — the same one for the life of the
 * world, so the market does not flap and the server, client and worker agree
 * without coordinating. A tiny FNV-1a over the world id chooses which; it is a
 * pure function of the id and nothing else.
 */
export function offeredSocialMediaSpecialistId(worldId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < worldId.length; i += 1) {
    hash ^= worldId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const index = (hash >>> 0) % SOCIAL_MEDIA_SPECIALISTS.length;
  const chosen = SOCIAL_MEDIA_SPECIALISTS[index] ?? SOCIAL_MEDIA_SPECIALISTS[0];
  if (chosen === undefined) throw new Error('no social media specialists are defined');
  return chosen.id;
}

/** A candidate's seniority band. Sets the pay: a Director costs more than an Analyst. */
export type OfficeCandidateTier = 'Analyst' | 'Manager' | 'Director';

/**
 * One person in the hiring market (§9.1), as all three parties must agree on them.
 *
 * The client renders the face, the server admits the hire and snapshots the pay,
 * and the worker bills it every month — so identity, role and **salary** are
 * shared, not the client's to assert. The server bills `monthlySalaryMinor` from
 * this catalogue keyed by `id`, never a figure the client sends, so a player
 * cannot hire a Director at an Analyst's rate; the tier is what makes the three
 * candidates for a seat cost different amounts. Portraits and the flavour trait
 * stay in the client — they are not billable and not the server's concern.
 */
export interface OfficeCandidate {
  /** Stable id, shared by the client roster, the wire and the payroll. */
  id: string;
  /** The role this candidate is for. A role seat must match it; specialists are `social-media`. */
  role: OfficeRole;
  name: string;
  tier: OfficeCandidateTier;
  /** Salary per game month, minor units — what the worker bills while they are on staff. */
  monthlySalaryMinor: number;
  /**
   * The candidate's own small standing boost (§9.1's "visible trait", now with
   * teeth). Unlike an executive, a seat still carries a concrete capability unlock
   * regardless of who fills it — this is the *extra* edge the individual brings,
   * and it is deliberately tiny and **derived from the salary** (see
   * {@link officeSeatBoost}) so it is always fair value for the pay. The lever is
   * the seat's characteristic one, so the boost reads as "what this seat is good
   * at, a little more".
   */
  boost: ExecutiveBoost;
}

/** The characteristic boost lever each seat's candidates carry. */
const SEAT_BOOST_LEVER: Readonly<Record<Exclude<OfficeRole, 'social-media'>, ExecutiveBoostLever>> =
  {
    'route-planner': 'route-demand',
    'revenue-manager': 'fare-yield',
    'ops-controller': 'on-time',
    'chief-pilot': 'aircraft-utilisation',
    'ground-ops': 'turnaround',
    'safety-compliance': 'reputation',
  };

/** One line of flavour per lever an office boost can use — the card's description. */
const OFFICE_BOOST_DESCRIPTION: Partial<Record<ExecutiveBoostLever, string>> = {
  'route-demand': 'Sniffs out a little extra demand on the routes you already fly.',
  'fare-yield': 'Squeezes a little more revenue from every seat sold.',
  'on-time': 'Keeps the bank a touch more punctual through a rough day.',
  'aircraft-utilisation': 'Keeps the line sharp, so each aircraft flies a little more.',
  turnaround: 'Trims a little off every turn on the ramp.',
  reputation: 'Keeps the airline’s standing a notch higher with a clean record.',
  'brand-attractiveness': 'Wins over a few more undecided travellers.',
};

/**
 * The tiny, salary-scaled boost an office candidate carries.
 *
 * A pure function of the lever and the pay, so it is always "worth their salary":
 * roughly 0.35% of edge per $10k/month, which lands ground-floor hires in a
 * 0.4%–1.1% band — a fraction of an executive's. A cost or duration lever (lower
 * is better) gets a negative magnitude; everything else positive.
 */
export function officeSeatBoost(lever: ExecutiveBoostLever, salaryMinor: number): ExecutiveBoost {
  const meta = EXECUTIVE_BOOST_LEVERS[lever];
  // Tenths of a percent, so the label reads cleanly to one decimal place.
  const tenths = Math.max(1, Math.round((salaryMinor / 1_000_000) * 3.5));
  const magnitude = (meta.lowerIsBetter ? -tenths : tenths) / 1000;
  const label = `${meta.label} ${meta.lowerIsBetter ? '−' : '+'}${(tenths / 10).toFixed(1)}%`;
  const description = OFFICE_BOOST_DESCRIPTION[lever] ?? `${meta.label}, a little better.`;
  return { lever, magnitude, label, description };
}

/** The lever a given candidate's boost uses — a specialist follows its own edge. */
function candidateBoostLever(candidate: Omit<OfficeCandidate, 'boost'>): ExecutiveBoostLever {
  if (candidate.role !== 'social-media') return SEAT_BOOST_LEVER[candidate.role];
  return candidate.id.includes('reputation') ? 'reputation' : 'brand-attractiveness';
}

/**
 * The candidate market: several people for each of the six seats, plus the two
 * social media specialists. Ordered by seat, then by roster order within a seat.
 * The boost on each is derived from the seat and the salary, so this raw list
 * carries only identity and pay; {@link OFFICE_CANDIDATES} attaches the boost.
 */
const RAW_OFFICE_CANDIDATES: readonly Omit<OfficeCandidate, 'boost'>[] = [
  {
    id: 'route-planner-mara',
    role: 'route-planner',
    name: 'Mara Ellison',
    tier: 'Manager',
    monthlySalaryMinor: 1_800_000,
  },
  {
    id: 'route-planner-tom',
    role: 'route-planner',
    name: 'Tom Bakker',
    tier: 'Analyst',
    monthlySalaryMinor: 1_200_000,
  },
  {
    id: 'route-planner-victor',
    role: 'route-planner',
    name: 'Victor Lindqvist',
    tier: 'Director',
    monthlySalaryMinor: 2_600_000,
  },
  {
    id: 'revenue-manager-kenji',
    role: 'revenue-manager',
    name: 'Kenji Tan',
    tier: 'Manager',
    monthlySalaryMinor: 2_000_000,
  },
  {
    id: 'revenue-manager-sofia',
    role: 'revenue-manager',
    name: 'Sofía Reyes',
    tier: 'Manager',
    monthlySalaryMinor: 2_100_000,
  },
  {
    id: 'revenue-manager-anders',
    role: 'revenue-manager',
    name: 'Anders Holm',
    tier: 'Director',
    monthlySalaryMinor: 2_900_000,
  },
  {
    id: 'ops-controller-diego',
    role: 'ops-controller',
    name: 'Diego Alvarez',
    tier: 'Director',
    monthlySalaryMinor: 2_600_000,
  },
  {
    id: 'ops-controller-marta',
    role: 'ops-controller',
    name: 'Marta Silva',
    tier: 'Manager',
    monthlySalaryMinor: 2_300_000,
  },
  {
    id: 'ops-controller-jun',
    role: 'ops-controller',
    name: 'Jun Park',
    tier: 'Director',
    monthlySalaryMinor: 2_700_000,
  },
  {
    id: 'chief-pilot-sten',
    role: 'chief-pilot',
    name: 'Sten Halvorsen',
    tier: 'Director',
    monthlySalaryMinor: 2_800_000,
  },
  {
    id: 'chief-pilot-fiona',
    role: 'chief-pilot',
    name: 'Fiona Brennan',
    tier: 'Director',
    monthlySalaryMinor: 2_900_000,
  },
  {
    id: 'chief-pilot-grant',
    role: 'chief-pilot',
    name: 'Grant Wexford',
    tier: 'Director',
    monthlySalaryMinor: 3_000_000,
  },
  {
    id: 'ground-ops-nadia',
    role: 'ground-ops',
    name: 'Nadia Kovač',
    tier: 'Director',
    monthlySalaryMinor: 2_400_000,
  },
  {
    id: 'ground-ops-omar',
    role: 'ground-ops',
    name: 'Omar Haddad',
    tier: 'Director',
    monthlySalaryMinor: 2_500_000,
  },
  {
    id: 'ground-ops-luca',
    role: 'ground-ops',
    name: 'Luca Moretti',
    tier: 'Manager',
    monthlySalaryMinor: 2_000_000,
  },
  {
    id: 'safety-compliance-claire',
    role: 'safety-compliance',
    name: 'Claire Fontaine',
    tier: 'Director',
    monthlySalaryMinor: 3_000_000,
  },
  {
    id: 'safety-compliance-hiroshi',
    role: 'safety-compliance',
    name: 'Hiroshi Tanaka',
    tier: 'Director',
    monthlySalaryMinor: 3_100_000,
  },
  {
    id: 'safety-compliance-emma',
    role: 'safety-compliance',
    name: 'Emma Larsson',
    tier: 'Manager',
    monthlySalaryMinor: 2_400_000,
  },
  // ── New arrivals (characters.zip), by seat ────────────────────────────────
  {
    id: 'route-planner-rahman',
    role: 'route-planner',
    name: 'Aisha Rahman',
    tier: 'Manager',
    monthlySalaryMinor: 1_900_000,
  },
  {
    id: 'route-planner-bianchi',
    role: 'route-planner',
    name: 'Marco Bianchi',
    tier: 'Director',
    monthlySalaryMinor: 2_700_000,
  },
  {
    id: 'route-planner-novak',
    role: 'route-planner',
    name: 'Ella Novak',
    tier: 'Analyst',
    monthlySalaryMinor: 1_300_000,
  },
  {
    id: 'route-planner-park',
    role: 'route-planner',
    name: 'Zoe Park',
    tier: 'Analyst',
    monthlySalaryMinor: 1_250_000,
  },
  {
    id: 'revenue-manager-lim',
    role: 'revenue-manager',
    name: 'Grace Lim',
    tier: 'Director',
    monthlySalaryMinor: 2_800_000,
  },
  {
    id: 'revenue-manager-petrova',
    role: 'revenue-manager',
    name: 'Nina Petrova',
    tier: 'Manager',
    monthlySalaryMinor: 2_050_000,
  },
  {
    id: 'ops-controller-boateng',
    role: 'ops-controller',
    name: 'Andre Boateng',
    tier: 'Manager',
    monthlySalaryMinor: 2_350_000,
  },
  {
    id: 'ops-controller-chen',
    role: 'ops-controller',
    name: 'Wei Chen',
    tier: 'Director',
    monthlySalaryMinor: 2_750_000,
  },
  {
    id: 'ops-controller-doyle',
    role: 'ops-controller',
    name: 'Karen Doyle',
    tier: 'Director',
    monthlySalaryMinor: 2_650_000,
  },
  {
    id: 'ops-controller-romano',
    role: 'ops-controller',
    name: 'Lucia Romano',
    tier: 'Manager',
    monthlySalaryMinor: 2_320_000,
  },
  {
    id: 'chief-pilot-nordheim',
    role: 'chief-pilot',
    name: 'Astrid Nordheim',
    tier: 'Director',
    monthlySalaryMinor: 2_950_000,
  },
  {
    id: 'chief-pilot-holloway',
    role: 'chief-pilot',
    name: 'Ray Holloway',
    tier: 'Director',
    monthlySalaryMinor: 3_050_000,
  },
  {
    id: 'chief-pilot-kelly',
    role: 'chief-pilot',
    name: 'Moira Kelly',
    tier: 'Director',
    monthlySalaryMinor: 2_850_000,
  },
  {
    id: 'chief-pilot-sokolova',
    role: 'chief-pilot',
    name: 'Elena Sokolova',
    tier: 'Director',
    monthlySalaryMinor: 3_020_000,
  },
  {
    id: 'ground-ops-okafor',
    role: 'ground-ops',
    name: 'Amara Okafor',
    tier: 'Director',
    monthlySalaryMinor: 2_450_000,
  },
  {
    id: 'ground-ops-adeyemi',
    role: 'ground-ops',
    name: 'Samuel Adeyemi',
    tier: 'Manager',
    monthlySalaryMinor: 2_100_000,
  },
  {
    id: 'ground-ops-kwon',
    role: 'ground-ops',
    name: 'David Kwon',
    tier: 'Director',
    monthlySalaryMinor: 2_520_000,
  },
  {
    id: 'ground-ops-herrera',
    role: 'ground-ops',
    name: 'Sofia Herrera',
    tier: 'Manager',
    monthlySalaryMinor: 2_150_000,
  },
  {
    id: 'safety-compliance-fischer',
    role: 'safety-compliance',
    name: 'Tom Fischer',
    tier: 'Manager',
    monthlySalaryMinor: 2_450_000,
  },
  {
    id: 'safety-compliance-braun',
    role: 'safety-compliance',
    name: 'Wolfgang Braun',
    tier: 'Director',
    monthlySalaryMinor: 3_150_000,
  },
  {
    id: 'safety-compliance-weiss',
    role: 'safety-compliance',
    name: 'Marion Weiss',
    tier: 'Director',
    monthlySalaryMinor: 3_050_000,
  },
  {
    id: 'social-media-reputation',
    role: 'social-media',
    name: 'Lena Voss',
    tier: 'Manager',
    monthlySalaryMinor: 1_500_000,
  },
  {
    id: 'social-media-attractiveness',
    role: 'social-media',
    name: 'Kai Mercer',
    tier: 'Manager',
    monthlySalaryMinor: 1_500_000,
  },
];

/**
 * The candidate market with each candidate's derived boost attached. The raw list
 * above is the single source of identity and pay; the boost is a pure function of
 * the two, so it cannot drift from the salary it is meant to be worth.
 */
export const OFFICE_CANDIDATES: readonly OfficeCandidate[] = RAW_OFFICE_CANDIDATES.map(
  (candidate) => ({
    ...candidate,
    boost: officeSeatBoost(candidateBoostLever(candidate), candidate.monthlySalaryMinor),
  }),
);

/** The candidate with this id, or undefined — the server's billing lookup. */
export function officeCandidate(id: string): OfficeCandidate | undefined {
  return OFFICE_CANDIDATES.find((candidate) => candidate.id === id);
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
  /**
   * The candidate id of the one social media specialist this world offers. The
   * server decides it (from the world id), so the client and the worker never
   * disagree about which specialist is on the market.
   */
  offeredSpecialist: z.string().min(1),
});
export type OfficeStateResponse = z.infer<typeof OfficeStateResponse>;

/** `POST /api/office/hires` — hire a candidate into a seat, replacing any incumbent. */
export const HireOfficeRequest = z
  .object({
    /** The seat to fill. A neutral seat must already be unlocked by expansion. */
    seat: OfficeSeatId,
    candidateId: z.string().min(1),
    candidateName: z.string().min(1),
    /**
     * The candidate's role. It sets the salary billed, and for a role seat it must
     * equal the seat — the server refuses a mismatch. A neutral seat accepts any role.
     */
    candidateRole: OfficeRole,
  })
  .strict();
export type HireOfficeRequest = z.infer<typeof HireOfficeRequest>;

/** The airline id is never on the wire — ownership is resolved from the session (AIR-05). */
export const OfficeAirlineId = Uuid;
