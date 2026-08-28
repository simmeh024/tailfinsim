import { z } from 'zod';

/**
 * The executive floor and its C-Suite (design §9.1 follow-up).
 *
 * A second headquarters floor, reached by the floor pager on the plan. It is a
 * late-game money sink with two gates stacked: the floor itself unlocks only
 * once the airline is both **rich enough** (a one-off charge) and **earning
 * enough** (a trailing monthly gross-revenue floor), and then each of its ten
 * offices unlocks in turn, right to left, each dearer than the last. The costs
 * are balance numbers — like the seat salaries and the expansion tiers they live
 * here until the office economy moves into the economy config — and every figure
 * is integer **minor units** ($1 = 100), so $100M is 10_000_000_000.
 *
 * Phase 1 builds the floor and the unlocks; the offices stay empty until the
 * C-Suite roster (directors, VPs, presidents) lands.
 */

/** What it costs to open the executive floor: a one-off $100M. */
export const EXECUTIVE_FLOOR_UNLOCK_COST_MINOR = 10_000_000_000;

/**
 * The trailing monthly gross flight revenue an airline must clear to be allowed
 * to open the floor — $50M a month. Gross revenue (what flights earned), summed
 * over the last game month; not profit, and not cash on hand.
 */
export const EXECUTIVE_FLOOR_REVENUE_GATE_MINOR = 5_000_000_000;

/** The executive floor has ten offices, like the ground floor. */
export const EXECUTIVE_OFFICE_COUNT = 10;

/**
 * The cost to unlock each executive office, in the order they open — right to
 * left, cheapest first. Index 0 is the first (rightmost) office at $75M; the
 * tenth is $5B. An office opens only once the one before it has.
 */
export const EXECUTIVE_OFFICE_COSTS_MINOR: readonly number[] = [
  7_500_000_000, // $75M
  10_000_000_000, // $100M
  15_000_000_000, // $150M
  20_000_000_000, // $200M
  40_000_000_000, // $400M
  50_000_000_000, // $500M
  100_000_000_000, // $1B
  150_000_000_000, // $1.5B
  250_000_000_000, // $2.5B
  500_000_000_000, // $5B
];

/**
 * The next office an airline can unlock, given how many it already holds, or null
 * once all ten are open. The index is 0-based into {@link EXECUTIVE_OFFICE_COSTS_MINOR}.
 */
export function nextExecutiveOffice(
  officesUnlocked: number,
): { index: number; costMinor: number } | null {
  if (officesUnlocked >= EXECUTIVE_OFFICE_COUNT) return null;
  const costMinor = EXECUTIVE_OFFICE_COSTS_MINOR[officesUnlocked];
  if (costMinor === undefined) return null;
  return { index: officesUnlocked, costMinor };
}

/**
 * The C-Suite roster (§9.1 follow-up, Phase 2).
 *
 * The people who staff the executive floor's offices. Unlike the ground-floor
 * seats, an executive office is **generic** — it has no fixed role, and any
 * C-Suite member fits any open office — so a hire consumes one free office rather
 * than filling a named seat. An airline can employ as many as it has **opened
 * offices**; past that the remaining candidates are locked until another office
 * opens.
 *
 * Like {@link OFFICE_CANDIDATES}, this catalogue is the **authoritative source of
 * a candidate's pay**: the server bills `monthlySalaryMinor` keyed by `id`, never
 * a figure the client sends, and snapshots it onto the hire so a later retune does
 * not silently re-price a standing executive. Portraits and role titles are the
 * client's to render and are not billable, so they live in the web roster.
 *
 * Phase 2 is the roster and the office-capacity gate; the roles and their
 * gameplay effects (the "higher boosts") land on top of this, keyed by the same
 * ids, exactly as the ground-floor traits will.
 */
export type ExecutiveCandidateTier = 'Director' | 'VP' | 'President';

/**
 * The game levers a C-Suite boost can move (§9.1 follow-up, Phase 3).
 *
 * Each executive carries **one** small, standing edge, and every lever is a real
 * quantity the simulation already tracks — a cost line, a demand driver, a
 * revenue stream or an operational margin — so the boosts aggregate into one
 * airline-wide modifier per lever (see {@link aggregateExecutiveBoosts}) that the
 * worker can apply the way it already applies the social-media specialist's edge.
 * Until that wiring lands the boosts are shown on the card and summed for the
 * player, exactly as the ground-floor traits are shown before they bite.
 */
export type ExecutiveBoostLever =
  | 'route-demand'
  | 'connection-demand'
  | 'long-haul-demand'
  | 'corporate-demand'
  | 'catchment'
  | 'brand-attractiveness'
  | 'loyalty'
  | 'reputation'
  | 'fare-yield'
  | 'ancillary-revenue'
  | 'interline-revenue'
  | 'cargo-yield'
  | 'premium-revenue'
  | 'interest-income'
  | 'fuel-cost'
  | 'maintenance-cost'
  | 'ground-cost'
  | 'overhead-cost'
  | 'turnaround'
  | 'delivery-lead-time'
  | 'on-time'
  | 'aircraft-utilisation'
  | 'crew-morale';

/** How a lever's magnitude reads: a percentage of the quantity, or raw points. */
export type ExecutiveBoostUnit = 'percent' | 'points';

export interface ExecutiveBoostLeverMeta {
  /** The lever's name in the player's terms, e.g. "Fuel cost". */
  label: string;
  unit: ExecutiveBoostUnit;
  /** True when a *lower* number is the good outcome — a cost or a duration. */
  lowerIsBetter: boolean;
}

/** Every lever's display metadata — the one place the summary and the badge read from. */
export const EXECUTIVE_BOOST_LEVERS: Readonly<
  Record<ExecutiveBoostLever, ExecutiveBoostLeverMeta>
> = {
  'route-demand': { label: 'Route demand', unit: 'percent', lowerIsBetter: false },
  'connection-demand': { label: 'Connecting demand', unit: 'percent', lowerIsBetter: false },
  'long-haul-demand': { label: 'Long-haul demand', unit: 'percent', lowerIsBetter: false },
  'corporate-demand': { label: 'Corporate demand', unit: 'percent', lowerIsBetter: false },
  catchment: { label: 'Hub catchment', unit: 'percent', lowerIsBetter: false },
  'brand-attractiveness': { label: 'Brand pull', unit: 'percent', lowerIsBetter: false },
  loyalty: { label: 'Passenger loyalty', unit: 'percent', lowerIsBetter: false },
  reputation: { label: 'Reputation', unit: 'percent', lowerIsBetter: false },
  'fare-yield': { label: 'Fare yield', unit: 'percent', lowerIsBetter: false },
  'ancillary-revenue': { label: 'Ancillary revenue', unit: 'percent', lowerIsBetter: false },
  'interline-revenue': { label: 'Interline revenue', unit: 'percent', lowerIsBetter: false },
  'cargo-yield': { label: 'Cargo yield', unit: 'percent', lowerIsBetter: false },
  'premium-revenue': { label: 'Premium revenue', unit: 'percent', lowerIsBetter: false },
  'interest-income': { label: 'Treasury income', unit: 'percent', lowerIsBetter: false },
  'fuel-cost': { label: 'Fuel cost', unit: 'percent', lowerIsBetter: true },
  'maintenance-cost': { label: 'Maintenance cost', unit: 'percent', lowerIsBetter: true },
  'ground-cost': { label: 'Ground cost', unit: 'percent', lowerIsBetter: true },
  'overhead-cost': { label: 'Overhead cost', unit: 'percent', lowerIsBetter: true },
  turnaround: { label: 'Turnaround time', unit: 'percent', lowerIsBetter: true },
  'delivery-lead-time': { label: 'Delivery lead time', unit: 'percent', lowerIsBetter: true },
  'on-time': { label: 'On-time performance', unit: 'percent', lowerIsBetter: false },
  'aircraft-utilisation': { label: 'Aircraft utilisation', unit: 'percent', lowerIsBetter: false },
  'crew-morale': { label: 'Crew morale', unit: 'points', lowerIsBetter: false },
};

export interface ExecutiveBoost {
  lever: ExecutiveBoostLever;
  /**
   * The signed change to the lever's quantity. A `percent` lever reads as a
   * fraction (0.015 = 1.5%); a `points` lever is the raw number. The sign is the
   * *direction of the change*, so a cost cut is negative — `lowerIsBetter` on the
   * lever is what turns a negative into "good" for the reader.
   */
  magnitude: number;
  /** The short badge on the card, e.g. "Fuel cost −1.5%". */
  label: string;
  /** One line of what it does, in the game's own terms. */
  description: string;
}

export interface ExecutiveCandidate {
  /** Stable id, shared by the client roster, the wire and the payroll. */
  id: string;
  /** The executive's name; the client renders it. */
  name: string;
  tier: ExecutiveCandidateTier;
  /** The functional role — the job title shown under the name. */
  role: string;
  /** Salary per game month, minor units — $150k to $1M ($1 = 100 minor). */
  monthlySalaryMinor: number;
  /** The single standing edge this executive brings while employed. */
  boost: ExecutiveBoost;
}

/**
 * The executive hiring market — twenty-four executives across the three C-Suite
 * bands, so there are always more people than the ten offices and the "no free
 * office" locked state is reachable. Each has a fitting role and one small,
 * **unique** standing boost that scales with seniority (Directors nudge, VPs
 * lift, Presidents move the needle). The ids are stable so a portrait, a role and
 * a standing hire all keep pointing at the same person.
 */
export const EXECUTIVE_CANDIDATES: readonly ExecutiveCandidate[] = [
  // ── Directors ─────────────────────────────────────────────────────────────
  {
    id: 'csuite-01',
    name: 'Gerald Whitmore',
    tier: 'Director',
    role: 'Director of Network Planning',
    monthlySalaryMinor: 15_000_000,
    boost: {
      lever: 'route-demand',
      magnitude: 0.015,
      label: 'Route demand +1.5%',
      description: 'Sharpens the schedule so a few more travellers find your flights each week.',
    },
  },
  {
    id: 'csuite-02',
    name: 'Ingrid Solberg',
    tier: 'Director',
    role: 'Director of Sustainability',
    monthlySalaryMinor: 17_000_000,
    boost: {
      lever: 'fuel-cost',
      magnitude: -0.015,
      label: 'Fuel cost −1.5%',
      description: 'Trims fuel burn with tighter tankering and continuous-descent profiles.',
    },
  },
  {
    id: 'csuite-03',
    name: 'Camila Rojas',
    tier: 'Director',
    role: 'Director of People & Culture',
    monthlySalaryMinor: 19_000_000,
    boost: {
      lever: 'crew-morale',
      magnitude: 2,
      label: 'Crew morale +2',
      description: 'Keeps crews a little happier at every base you open.',
    },
  },
  {
    id: 'csuite-04',
    name: 'Rajan Mehta',
    tier: 'Director',
    role: 'Director of Corporate Affairs',
    monthlySalaryMinor: 21_000_000,
    boost: {
      lever: 'reputation',
      magnitude: 0.015,
      label: 'Reputation +1.5%',
      description: 'Steady press and regulator relations lift your public standing.',
    },
  },
  {
    id: 'csuite-05',
    name: 'Dana Whitfield',
    tier: 'Director',
    role: 'Director of Information Systems',
    monthlySalaryMinor: 23_000_000,
    boost: {
      lever: 'overhead-cost',
      magnitude: -0.015,
      label: 'Overhead −1.5%',
      description: 'Automates back-office work, shaving fixed administrative cost.',
    },
  },
  {
    id: 'csuite-06',
    name: 'Lars Ohlsson',
    tier: 'Director',
    role: 'Director of Fleet Planning',
    monthlySalaryMinor: 25_000_000,
    boost: {
      lever: 'delivery-lead-time',
      magnitude: -0.03,
      label: 'Delivery lead time −3%',
      description: 'Works the order book so new aircraft arrive a touch sooner.',
    },
  },
  {
    id: 'csuite-07',
    name: 'Khalid Al-Mansoori',
    tier: 'Director',
    role: 'Director of Regional Partnerships',
    monthlySalaryMinor: 27_000_000,
    boost: {
      lever: 'catchment',
      magnitude: 0.015,
      label: 'Hub catchment +1.5%',
      description: 'Local tie-ups widen the catchment feeding your hubs.',
    },
  },
  {
    id: 'csuite-08',
    name: 'Yvonne Carter',
    tier: 'Director',
    role: 'Director of Customer Experience',
    monthlySalaryMinor: 30_000_000,
    boost: {
      lever: 'loyalty',
      magnitude: 0.015,
      label: 'Loyalty +1.5%',
      description: 'Small service touches bring a few more passengers back.',
    },
  },
  // ── Vice Presidents ─────────────────────────────────────────────────────────
  {
    id: 'csuite-09',
    name: 'Elena Marchetti',
    tier: 'VP',
    role: 'VP, Revenue Management',
    monthlySalaryMinor: 34_000_000,
    boost: {
      lever: 'fare-yield',
      magnitude: 0.025,
      label: 'Fare yield +2.5%',
      description: 'Tighter fare control lifts the revenue earned on every seat.',
    },
  },
  {
    id: 'csuite-10',
    name: 'Sabine Kessler',
    tier: 'VP',
    role: 'VP, Network Strategy',
    monthlySalaryMinor: 38_000_000,
    boost: {
      lever: 'connection-demand',
      magnitude: 0.025,
      label: 'Connecting demand +2.5%',
      description: 'Rebanks the waves so more itineraries connect over your hubs.',
    },
  },
  {
    id: 'csuite-11',
    name: 'Freya Lindgren',
    tier: 'VP',
    role: 'VP, Marketing',
    monthlySalaryMinor: 42_000_000,
    boost: {
      lever: 'brand-attractiveness',
      magnitude: 0.025,
      label: 'Brand pull +2.5%',
      description: 'Campaigns tilt undecided travellers your way.',
    },
  },
  {
    id: 'csuite-12',
    name: 'Mateo Duarte',
    tier: 'VP',
    role: 'VP, Operations',
    monthlySalaryMinor: 46_000_000,
    boost: {
      lever: 'turnaround',
      magnitude: -0.025,
      label: 'Turnaround −2.5%',
      description: 'Sharper ramp choreography gives back minutes on every turn.',
    },
  },
  {
    id: 'csuite-13',
    name: 'Priya Anand',
    tier: 'VP',
    role: 'VP, Brand & Loyalty',
    monthlySalaryMinor: 50_000_000,
    boost: {
      lever: 'ancillary-revenue',
      magnitude: 0.025,
      label: 'Ancillary +2.5%',
      description: 'Turns bags, seats and lounges into a bigger revenue line.',
    },
  },
  {
    id: 'csuite-14',
    name: 'Giancarlo Rossi',
    tier: 'VP',
    role: 'VP, Alliances',
    monthlySalaryMinor: 54_000_000,
    boost: {
      lever: 'interline-revenue',
      magnitude: 0.025,
      label: 'Interline +2.5%',
      description: 'Codeshare and interline deals feed extra traffic onto your metal.',
    },
  },
  {
    id: 'csuite-15',
    name: 'Andre Laurent',
    tier: 'VP',
    role: 'VP, Commercial',
    monthlySalaryMinor: 58_000_000,
    boost: {
      lever: 'corporate-demand',
      magnitude: 0.025,
      label: 'Corporate demand +2.5%',
      description: 'Corporate contracts fill more of the front cabins midweek.',
    },
  },
  {
    id: 'csuite-16',
    name: 'Marcus Bell',
    tier: 'VP',
    role: 'VP, Cargo',
    monthlySalaryMinor: 62_000_000,
    boost: {
      lever: 'cargo-yield',
      magnitude: 0.03,
      label: 'Cargo yield +3%',
      description: 'Fills the belly holds that would otherwise fly empty.',
    },
  },
  // ── Presidents ──────────────────────────────────────────────────────────────
  {
    id: 'csuite-17',
    name: 'Mei-Lin Chen',
    tier: 'President',
    role: 'President, Ground Operations',
    monthlySalaryMinor: 66_000_000,
    boost: {
      lever: 'ground-cost',
      magnitude: -0.03,
      label: 'Ground cost −3%',
      description: 'Self-handling and better station deals cut ground charges.',
    },
  },
  {
    id: 'csuite-18',
    name: 'Henrik Dahl',
    tier: 'President',
    role: 'President, Engineering & Maintenance',
    monthlySalaryMinor: 72_000_000,
    boost: {
      lever: 'maintenance-cost',
      magnitude: -0.035,
      label: 'Maintenance −3.5%',
      description: 'Reliability programmes cut unscheduled maintenance spend.',
    },
  },
  {
    id: 'csuite-19',
    name: 'Nathan Cole',
    tier: 'President',
    role: 'President, Global Network',
    monthlySalaryMinor: 78_000_000,
    boost: {
      lever: 'long-haul-demand',
      magnitude: 0.035,
      label: 'Long-haul demand +3.5%',
      description: 'Opens and defends the long, thin routes rivals avoid.',
    },
  },
  {
    id: 'csuite-20',
    name: 'Hiroshi Nakamura',
    tier: 'President',
    role: 'President, International',
    monthlySalaryMinor: 84_000_000,
    boost: {
      lever: 'interest-income',
      magnitude: 0.035,
      label: 'Treasury +3.5%',
      description: 'Prudent treasury management earns more on the cash you hold.',
    },
  },
  {
    id: 'csuite-21',
    name: 'Diego Ferrer',
    tier: 'President',
    role: 'President, Operations',
    monthlySalaryMinor: 90_000_000,
    boost: {
      lever: 'on-time',
      magnitude: 0.035,
      label: 'On-time +3.5%',
      description: 'Company-wide punctuality discipline keeps banks intact through disruption.',
    },
  },
  {
    id: 'csuite-22',
    name: 'Charlotte Reeves',
    tier: 'President',
    role: 'President, Commercial',
    monthlySalaryMinor: 94_000_000,
    boost: {
      lever: 'fare-yield',
      magnitude: 0.04,
      label: 'Fare yield +4%',
      description: 'Group pricing strategy squeezes more from every seat sold.',
    },
  },
  {
    id: 'csuite-23',
    name: 'Emilio Vargas',
    tier: 'President',
    role: 'President, Premium & Charter',
    monthlySalaryMinor: 97_000_000,
    boost: {
      lever: 'premium-revenue',
      magnitude: 0.04,
      label: 'Premium revenue +4%',
      description: 'Grows charter and premium-cabin demand across the network.',
    },
  },
  {
    id: 'csuite-24',
    name: 'Adrian Costa',
    tier: 'President',
    role: 'President & Group COO',
    monthlySalaryMinor: 100_000_000,
    boost: {
      lever: 'aircraft-utilisation',
      magnitude: 0.04,
      label: 'Utilisation +4%',
      description: 'Tighter scheduling flies each aircraft a little more each day.',
    },
  },
];

/** The executive candidate with this id, or undefined — the server's billing lookup. */
export function executiveCandidate(id: string): ExecutiveCandidate | undefined {
  return EXECUTIVE_CANDIDATES.find((candidate) => candidate.id === id);
}

/** One lever's total edge across a set of employed executives. */
export interface AggregatedExecutiveBoost {
  lever: ExecutiveBoostLever;
  /** The summed signed magnitude, in the lever's own unit. */
  totalMagnitude: number;
}

/**
 * The airline-wide boost each lever gets from a set of employed executives.
 *
 * Sums the boosts of the given candidate ids by lever, skipping ids that are not
 * real candidates, and returns one entry per lever that has any edge, in
 * {@link EXECUTIVE_BOOST_LEVERS} order so the summary is stable. This is the shape
 * the worker will read to apply the C-Suite's standing effects, and the shape the
 * client shows as "what your C-Suite currently gives".
 */
export function aggregateExecutiveBoosts(
  candidateIds: readonly string[],
): AggregatedExecutiveBoost[] {
  const totals = new Map<ExecutiveBoostLever, number>();
  for (const id of candidateIds) {
    const candidate = executiveCandidate(id);
    if (candidate === undefined) continue;
    const { lever, magnitude } = candidate.boost;
    totals.set(lever, (totals.get(lever) ?? 0) + magnitude);
  }
  const order = Object.keys(EXECUTIVE_BOOST_LEVERS) as ExecutiveBoostLever[];
  return order
    .filter((lever) => totals.has(lever))
    .map((lever) => ({ lever, totalMagnitude: totals.get(lever) ?? 0 }));
}

/** One executive hired into a (generic) office, as the client sees it. */
export const ExecutiveHire = z.object({
  candidateId: z.string().min(1),
  candidateName: z.string().min(1),
  monthlySalaryMinor: z.number().int().nonnegative(),
  hiredAt: z.string(),
});
export type ExecutiveHire = z.infer<typeof ExecutiveHire>;

/** The floor's state for the client — what is unlocked, and what the next gate is. */
export const ExecutiveFloorState = z
  .object({
    /** Whether the executive floor itself has been opened. */
    unlocked: z.boolean(),
    /** How many of its ten offices are open (0–10). */
    officesUnlocked: z.number().int().min(0).max(EXECUTIVE_OFFICE_COUNT),
    /** The one-off charge to open the floor. */
    unlockCostMinor: z.number().int().nonnegative(),
    /** The monthly gross-revenue floor to be allowed to open it. */
    revenueGateMinor: z.number().int().nonnegative(),
    /** The airline's own trailing monthly gross revenue, for the "need X more" overlay. */
    monthlyRevenueMinor: z.number().int().nonnegative(),
    /** The next office to unlock and its cost, or null when all ten are open. */
    nextOffice: z.object({ index: z.number().int(), costMinor: z.number().int() }).nullable(),
    /** The C-Suite members currently staffing the open offices. */
    hires: z.array(ExecutiveHire),
  })
  .strict();
export type ExecutiveFloorState = z.infer<typeof ExecutiveFloorState>;

/** `POST /api/office/executive/hires` — put a C-Suite candidate into a free office. */
export const HireExecutiveRequest = z.object({ candidateId: z.string().min(1) }).strict();
export type HireExecutiveRequest = z.infer<typeof HireExecutiveRequest>;
