import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  SkillPoints,
  skillBranchDefinition,
  type AirlineBoostView,
  type BoostCeiling,
  type CrewMemberView,
  type CrewRosterResponse,
  type CrewSkillBalance,
  type SkillBranch,
  type SkillBranchView,
  type CrewSkillRefusal,
} from '@tailfin/shared';
import {
  canSpendPoint,
  crewNameFor,
  levelForXp,
  skillBoosts,
  stackAirlineSkills,
  treeFor,
  typeMasteryActive,
  unspentPoints,
  xpForLevel,
  xpToNextLevel,
  type SkilledCrew,
} from '@tailfin/sim';

import {
  aircraftType,
  airframe,
  crewBase,
  crewMember,
  crewPool,
  world,
  type CrewRankValue,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * The roster board: naming crew, spending their points, and what they are worth
 * (M9-03, §10.2).
 *
 * `packages/sim` owns the arithmetic — levels, points, and which of §10.4's
 * ceilings a branch feeds. This file owns the rows, the naming sweep and the one
 * query that turns an airline's named crew into the boosts a flight is priced
 * with.
 *
 * ## Owner-scoped by resolution
 *
 * Every read and write is scoped by the session-resolved airline (ADR-0020). A
 * member belonging to somebody else is not in the result set, so operating on
 * one is not a state a request can express.
 *
 * ## What is deliberately absent
 *
 * There is **no respec**. §10.2 calls the points *"mostly irreversible"* and the
 * honest reading of that is a one-way door: a refund would make Type Mastery's
 * whole trade — *"big bonuses, lost if you sell that fleet"* — a temporary
 * inconvenience rather than a decision. If a respec ever arrives it should cost
 * something and be its own issue.
 *
 * There is also **no way to retire or dismiss a named member**. They are one of
 * the pool's heads; the pool's own attrition (`reviewCrewMorale`) is what
 * removes heads, and tying a resignation to a *specific* named person would need
 * the roster assignment §9.1 exists to prevent.
 */

export type RosterResult<T> = { ok: true; value: T } | { ok: false; refusal: CrewSkillRefusal };

interface RosterOwner {
  worldId: string;
  airlineId: string;
}

/** Parse a member's stored points, tolerating a row written by an older build. */
export function parseSkillPoints(json: string): SkillPoints {
  try {
    const parsed: unknown = JSON.parse(json);
    const result = SkillPoints.safeParse(parsed);
    return result.success ? result.data : {};
  } catch {
    // A corrupt cell must not take the whole roster down. An unparseable
    // allocation reads as "nothing spent", which is recoverable; throwing would
    // make one bad row hide every other member on the page.
    return {};
  }
}

function parseFamilies(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The aircraft families the airline currently operates.
 *
 * What §10.2's *"lost if you sell that fleet"* is checked against. Read from
 * `airframe` rather than from the crew's own ratings, because the question is
 * what the **airline** flies, not what its crew could fly — an airline that
 * sold every A320 still has A320-rated crew, and that is exactly the case the
 * acceptance criterion is about.
 *
 * A repossessed airframe does not count: it is out of the fleet in every other
 * sense (§13.5), so counting it here would keep a Type Mastery bonus alive on a
 * fleet the lender has taken.
 */
export async function operatedFamilies(db: Database, own: RosterOwner): Promise<string[]> {
  /*
   * The family is the **catalogue's**, not the airframe's: `airframe` stores a
   * type designation and `aircraft_type` maps it to a family, the same join
   * `crewDemand` uses. A seized aeroplane is excluded for §13.5's reason — it is
   * out of the fleet in every other sense, so counting it here would keep a Type
   * Mastery bonus alive on a fleet the lender has taken.
   */
  const rows = await db
    .selectDistinct({ family: aircraftType.family })
    .from(airframe)
    .innerJoin(aircraftType, eq(aircraftType.designation, airframe.typeDesignation))
    .where(
      and(
        eq(airframe.worldId, own.worldId),
        eq(airframe.airlineId, own.airlineId),
        sql`${airframe.repossessedAt} IS NULL`,
      ),
    );
  return rows
    .map((row) => row.family)
    .filter((family): family is string => family !== null)
    .sort((a, b) => a.localeCompare(b));
}

interface MemberRow {
  id: string;
  crewBaseId: string;
  family: string;
  rank: string;
  name: string;
  xp: number;
  level: number;
  skillPoints: string;
  careerBlockMinutes: number;
  careerSectors: number;
  careerIncidents: number;
  careerFamilies: string;
  namedAt: Date;
}

async function readMembers(db: Database, own: RosterOwner): Promise<MemberRow[]> {
  return db
    .select({
      id: crewMember.id,
      crewBaseId: crewMember.crewBaseId,
      family: crewMember.family,
      rank: crewMember.rank,
      name: crewMember.name,
      xp: crewMember.xp,
      level: crewMember.level,
      skillPoints: crewMember.skillPoints,
      careerBlockMinutes: crewMember.careerBlockMinutes,
      careerSectors: crewMember.careerSectors,
      careerIncidents: crewMember.careerIncidents,
      careerFamilies: crewMember.careerFamilies,
      namedAt: crewMember.namedAt,
    })
    .from(crewMember)
    .where(and(eq(crewMember.worldId, own.worldId), eq(crewMember.airlineId, own.airlineId)))
    .orderBy(crewMember.level, crewMember.name);
}

function skilledOf(row: MemberRow): SkilledCrew {
  return {
    rank: row.rank as SkilledCrew['rank'],
    family: row.family,
    level: row.level,
    spent: parseSkillPoints(row.skillPoints),
  };
}

/** The whole roster board, in one response. */
export async function readRoster(db: Database, own: RosterOwner): Promise<CrewRosterResponse> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const balance = economy.crew.skills;

  const [rows, families] = await Promise.all([readMembers(db, own), operatedFamilies(db, own)]);

  const icaoByBase = new Map(
    (
      await db
        .select({ id: crewBase.id, airportIcao: crewBase.airportIcao })
        .from(crewBase)
        .where(and(eq(crewBase.worldId, own.worldId), eq(crewBase.airlineId, own.airlineId)))
    ).map((base) => [base.id, base.airportIcao] as const),
  );

  const members: CrewMemberView[] = rows.map((row) => {
    const crew = skilledOf(row);
    return {
      id: row.id,
      name: row.name,
      rank: crew.rank,
      family: row.family,
      crewBaseId: row.crewBaseId,
      airportIcao: icaoByBase.get(row.crewBaseId) ?? '????',
      level: row.level,
      xp: row.xp,
      xpToNextLevel: xpToNextLevel(row.xp, balance),
      spent: crew.spent,
      unspentPoints: unspentPoints(row.level, crew.spent, balance),
      career: {
        blockHours: Math.round((row.careerBlockMinutes / 60) * 10) / 10,
        sectors: row.careerSectors,
        typesFlown: parseFamilies(row.careerFamilies),
        incidentsHandled: row.careerIncidents,
      },
      namedAt: row.namedAt.toISOString(),
      typeMasteryActive: typeMasteryActive(crew, families),
    };
  });

  /*
   * The tree, per branch, aggregated across the roster. A player asking *"what
   * is Handling & Safety doing for me?"* wants the airline's answer, not one
   * pilot's — the per-member allocation is on the card.
   */
  const branches: SkillBranchView[] = [...new Set(rows.map((row) => row.rank))]
    .flatMap((rank) => treeFor(rank as SkilledCrew['rank']))
    .filter(
      (definition, index, all) =>
        all.findIndex((other) => other.branch === definition.branch) === index,
    )
    .map((definition) => {
      const spent = rows.reduce(
        (total, row) => total + (parseSkillPoints(row.skillPoints)[definition.branch] ?? 0),
        0,
      );
      const active = !definition.familyBound || rows.some((row) => families.includes(row.family));
      return {
        branch: definition.branch,
        name: definition.name,
        effect: definition.effect,
        ceiling: definition.ceiling,
        familyBound: definition.familyBound,
        spent,
        maxPoints: balance.maxPointsPerBranch,
        fraction: Math.min(1, spent * balance.fractionPerPoint[definition.branch]),
        active,
      };
    });

  const stacked = stackAirlineSkills(
    rows.map(skilledOf),
    families,
    balance,
    economy.boosts.ceilings,
  );
  const boosts: AirlineBoostView[] = (Object.keys(stacked.stacked) as BoostCeiling[]).map(
    (ceiling) => ({
      ceiling,
      fraction: stacked.stacked[ceiling].fraction,
      maxFraction: economy.boosts.ceilings[ceiling],
      capped: stacked.stacked[ceiling].capped,
      contributors: stacked.contributors[ceiling],
    }),
  );

  return {
    members,
    branches,
    boosts,
    operatedFamilies: families,
    namedFromLevel: balance.namedFromLevel,
  };
}

/**
 * Spend one point.
 *
 * The member is re-read `FOR UPDATE` inside the transaction rather than trusting
 * what the page showed: two clicks arriving together would each pass a check
 * made against the same stale allocation and together spend a point that was
 * only earned once.
 */
export async function allocateSkillPoint(
  db: Database,
  own: RosterOwner,
  memberId: string,
  branch: SkillBranch,
): Promise<RosterResult<{ spent: SkillPoints }>> {
  const balance = (await loadWorldEconomyConfig(db, own.worldId)).crew.skills;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: crewMember.id,
        rank: crewMember.rank,
        family: crewMember.family,
        level: crewMember.level,
        skillPoints: crewMember.skillPoints,
      })
      .from(crewMember)
      .where(
        and(
          eq(crewMember.id, memberId),
          eq(crewMember.airlineId, own.airlineId),
          eq(crewMember.worldId, own.worldId),
        ),
      )
      .limit(1)
      .for('update');
    if (!row) return { ok: false, refusal: 'member_absent' as const };

    const crew: SkilledCrew = {
      rank: row.rank,
      family: row.family,
      level: row.level,
      spent: parseSkillPoints(row.skillPoints),
    };

    const refusal = canSpendPoint(crew, branch, balance);
    if (refusal !== null) return { ok: false, refusal };

    const spent: SkillPoints = { ...crew.spent, [branch]: (crew.spent[branch] ?? 0) + 1 };
    await tx
      .update(crewMember)
      .set({ skillPoints: JSON.stringify(spent) })
      .where(eq(crewMember.id, memberId));

    return { ok: true, value: { spent } };
  });
}

// ---------------------------------------------------------------------------
// The worker's sweep
// ---------------------------------------------------------------------------

export interface NamingResult {
  named: number;
}

/**
 * Name the crew who have earned it (§10.2).
 *
 * > *"Crew who cross a level threshold become **named, tracked individuals**."*
 *
 * A pool earns one named member when its XP **per head** reaches
 * `namedFromLevel`, and one more for each level above that — never more than it
 * has heads. That rule is a pure function of the pool's current state, which is
 * what makes this idempotent without a watermark column: run it twice and the
 * second run computes the same target and inserts nothing. ADR-0005's world
 * reset therefore has nothing extra to clear.
 *
 * Game time, like every in-world event. Naming happens *inside* the world, so a
 * world at 4× produces its first named captain twice as fast in real time —
 * which is the same rule ADR-0026 applies to everything else a player waits for.
 *
 * **Production has no worker**, so no crew are ever named there and the roster
 * board stays empty for ever — which reads as an airline whose crew are not good
 * enough yet rather than as a missing process, the same trap as everything
 * around it.
 */
export async function nameEligibleCrew(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<NamingResult> {
  const balance = (await loadWorldEconomyConfig(db, worldId)).crew.skills;

  const [seedRow] = await db
    .select({ seed: world.seed })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  // A world whose row has gone (a reset mid-sweep) names nobody rather than
  // drawing from a seed it does not have.
  if (!seedRow) return { named: 0 };

  const pools = await db
    .select({
      crewBaseId: crewPool.crewBaseId,
      airlineId: crewBase.airlineId,
      family: crewPool.family,
      rank: crewPool.rank,
      headcount: crewPool.headcount,
      xp: crewPool.xp,
    })
    .from(crewPool)
    .innerJoin(crewBase, eq(crewBase.id, crewPool.crewBaseId))
    .where(and(eq(crewBase.worldId, worldId), eq(crewBase.status, 'open')));

  let named = 0;
  for (const pool of pools) {
    if (pool.headcount <= 0 || pool.xp <= 0) continue;
    const perHead = Math.floor(pool.xp / pool.headcount);
    const level = levelForXp(perHead, balance);
    if (level < balance.namedFromLevel) continue;

    // One at the threshold, one more per level above it, capped by the heads
    // that actually exist — a pool of three cannot have four famous pilots.
    const target = Math.min(level - balance.namedFromLevel + 1, pool.headcount);

    const existing = await db
      .select({ id: crewMember.id })
      .from(crewMember)
      .where(
        and(
          eq(crewMember.crewBaseId, pool.crewBaseId),
          eq(crewMember.family, pool.family),
          eq(crewMember.rank, pool.rank),
        ),
      );
    if (existing.length >= target) continue;

    /*
     * The ordinal is per *base*, not per pool, so one base's roster is one
     * sequence and two pools naming on the same tick cannot draw the same name.
     * Counted rather than stored: a column would be one more thing for a world
     * reset to clear.
     */
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(crewMember)
      .where(eq(crewMember.crewBaseId, pool.crewBaseId));

    let ordinal = Number(count);
    for (let n = existing.length; n < target; n += 1) {
      const inserted = await db
        .insert(crewMember)
        .values({
          worldId,
          airlineId: pool.airlineId,
          crewBaseId: pool.crewBaseId,
          family: pool.family,
          rank: pool.rank,
          name: crewNameFor(seedRow.seed, pool.crewBaseId, ordinal),
          ordinal,
          // Their own XP starts at the pool's per-head average: that is what
          // they earned to get here, and it is what puts them at the level the
          // threshold just recognised.
          xp: perHead,
          level,
          careerFamilies: JSON.stringify([pool.family]),
          namedAt: gameNow,
        })
        /*
         * The race guard. Two workers sweeping the same base compute the same
         * ordinal, so the loser's insert is refused rather than producing a
         * second person with the same name.
         */
        .onConflictDoNothing({ target: [crewMember.crewBaseId, crewMember.ordinal] })
        .returning({ id: crewMember.id });
      ordinal += 1;
      if (inserted.length > 0) named += 1;
    }
  }

  return { named };
}

/**
 * Credit the named members of the pools a flight drew from (M9-03).
 *
 * Called from the XP award, inside the settlement, so it inherits that path's
 * once-per-flight guarantee.
 *
 * ## The approximation, stated
 *
 * The game does not track **which individual** flew which sector — dispatch
 * commits a count, and M5-01's whole design is that it never commits a person.
 * So a named member is credited for the flights their pool flew, at the rate
 * every head aboard earned. That over-credits somebody who would in reality have
 * been rostered on only some of them.
 *
 * The alternative is assigning individuals to duty periods, which is the
 * rostering interface §9.1 exists to prevent. This is the honest cost of the
 * pool model, and it is recorded here rather than left to be discovered from the
 * numbers.
 */
export async function creditNamedCrew(
  db: Database,
  input: {
    crewBaseId: string;
    family: string;
    ranks: readonly CrewRankValue[];
    xpPerHead: number;
    blockMinutes: number;
    handledDisruption: boolean;
  },
  balance: CrewSkillBalance,
): Promise<{ credited: number }> {
  if (input.ranks.length === 0 || input.xpPerHead <= 0) return { credited: 0 };

  const rows = await db
    .select({
      id: crewMember.id,
      xp: crewMember.xp,
      level: crewMember.level,
      careerFamilies: crewMember.careerFamilies,
    })
    .from(crewMember)
    .where(
      and(
        eq(crewMember.crewBaseId, input.crewBaseId),
        eq(crewMember.family, input.family),
        inArray(crewMember.rank, input.ranks),
      ),
    );
  if (rows.length === 0) return { credited: 0 };

  for (const row of rows) {
    const xp = row.xp + input.xpPerHead;
    const families = parseFamilies(row.careerFamilies);
    if (!families.includes(input.family)) families.push(input.family);
    await db
      .update(crewMember)
      .set({
        xp,
        /*
         * Never downward. A retune of the XP curve must not take away a level
         * somebody has already spent the points from — §10.2's *"mostly
         * irreversible"* cuts both ways, and a member who lost a point they had
         * committed would be a refund nobody asked for.
         */
        level: Math.max(row.level, levelForXp(xp, balance)),
        careerBlockMinutes: sql`${crewMember.careerBlockMinutes} + ${Math.round(input.blockMinutes)}`,
        careerSectors: sql`${crewMember.careerSectors} + 1`,
        careerIncidents: input.handledDisruption
          ? sql`${crewMember.careerIncidents} + 1`
          : sql`${crewMember.careerIncidents}`,
        careerFamilies: JSON.stringify(families),
      })
      .where(eq(crewMember.id, row.id));
  }

  return { credited: rows.length };
}

/**
 * An airline's stacked skill boosts, for the flight model to price against.
 *
 * The one place a settlement asks *"what are this airline's crew worth?"*.
 * Returns the **unstacked** entries per ceiling as well, so a caller that has
 * other sources to add — M9-04's Training Captains, M9-05's research — stacks
 * them together against one ceiling rather than applying two caps in series.
 */
export async function airlineSkillBoosts(db: Database, own: RosterOwner) {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const [rows, families] = await Promise.all([readMembers(db, own), operatedFamilies(db, own)]);
  return stackAirlineSkills(
    rows.map(skilledOf),
    families,
    economy.crew.skills,
    economy.boosts.ceilings,
  );
}

/** What one member's points are worth, for a test or an explanation. */
export function memberBoosts(
  row: MemberRow,
  families: readonly string[],
  balance: CrewSkillBalance,
) {
  return skillBoosts(skilledOf(row), families, balance);
}

/** The branch a spend names, resolved to its definition. Throws on an unknown one. */
export function branchDefinition(branch: SkillBranch) {
  return skillBranchDefinition(branch);
}

/** The XP a member needs for a given level, for the roster's progress bar. */
export { xpForLevel };
