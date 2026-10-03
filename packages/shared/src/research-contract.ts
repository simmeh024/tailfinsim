import { z } from 'zod';

import {
  ACADEMY_LEVELS,
  AcademyCommissionedLevel,
  AcademyLevel,
  type AcademyLevelDefinition,
  ResearchTier,
} from './academy';
import { MinorUnits, Timestamp } from './primitives';
import { ResearchBranch, ResearchEffectTarget, ResearchNodeId } from './research';

/**
 * §10.3's research tree: the tier gate and the wire contract (M9-05).
 *
 * The tree itself — branches, nodes, targets, prerequisites — is `research.ts`.
 * This half is here rather than there for one mechanical reason: it needs
 * `academy.ts` at module load (the tier gate reads `ACADEMY_LEVELS`, and the
 * response schemas embed `ResearchTier` and `AcademyLevel`), and `academy.ts`
 * imports `economy-config.ts`, which now needs the tree to validate
 * `EconomyConfig.research`. With both halves in one file that is an import
 * cycle, and the side of it that loses throws a TDZ error at whichever module
 * happens to be evaluated first. So the tree depends on nothing that depends
 * on the economy, and everything here may.
 *
 * Both files are re-exported from the package index, so no consumer imports
 * either by path.
 */

/**
 * The lowest academy level whose ceiling opens a research tier (§10.1's table).
 *
 * Read from `ACADEMY_LEVELS` rather than restated, so the tier gate and the
 * academy's own *"Research tier"* column cannot disagree: tier 1 at a Training
 * Room, tier 2 at a Flight Academy, tier 3 at a Full-Flight Sim Centre and tier
 * 4 at a Centre of Excellence.
 */
export function academyLevelForResearchTier(tier: ResearchTier): AcademyLevelDefinition {
  const found = ACADEMY_LEVELS.find((row) => row.researchTier >= tier);
  if (!found) throw new Error(`No academy level opens research tier ${String(tier)}`);
  return found;
}

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

export const ResearchNodeStatus = z.enum(['complete', 'in_progress', 'available', 'locked']);
export type ResearchNodeStatus = z.infer<typeof ResearchNodeStatus>;

/**
 * The closed set of reasons a research request is refused.
 *
 * Codes rather than prose, for the reason `AcademyRefusal` is: each one sits
 * beside a different control. `academy_level` is *build a bigger academy*,
 * `prerequisite` is *research the tier below first*, `insufficient_points` is
 * *fly more, or wait*, and only one of them can be fixed with money — and it is
 * not the research points, which no path converts cash into.
 */
export const ResearchRefusal = z.enum([
  /** No academy of the level this tier needs. The AC's *"facility level required"*. */
  'academy_level',
  /** The tier below in this branch is not complete. */
  'prerequisite',
  /** Tiers 3 and 4 are visible and priced, and not in this release (issue #92). */
  'not_released',
  'already_complete',
  /** This node is the project already running. */
  'already_in_progress',
  /** Another node is being researched. One project at a time, airline-wide. */
  'project_running',
  'insufficient_points',
  'insufficient_funds',
]);
export type ResearchRefusal = z.infer<typeof ResearchRefusal>;

/** What a node costs. Every figure explicit — issue #92's *"no placeholders"*. */
export const ResearchCost = z
  .object({
    researchPoints: z.number().int().positive(),
    cashMinor: MinorUnits.positive(),
    /** Weeks of the **world's** calendar (ADR-0026). No lever shortens it. */
    buildWeeks: z.number().int().positive(),
  })
  .strict();
export type ResearchCost = z.infer<typeof ResearchCost>;

export const ResearchEffectView = z
  .object({
    target: ResearchEffectTarget,
    /** Removed from an efficiency quantity, or added to crew XP. 0.015 is 1.5%. */
    fraction: z.number().gt(0).lt(1),
  })
  .strict();
export type ResearchEffectView = z.infer<typeof ResearchEffectView>;

export const ResearchNodeView = z
  .object({
    id: ResearchNodeId,
    branch: ResearchBranch,
    tier: ResearchTier,
    name: z.string().min(1),
    description: z.string().min(1),
    /** From the world's balance. Empty for a node outside this release. */
    effects: z.array(ResearchEffectView),
    cost: ResearchCost,
    released: z.boolean(),
    status: ResearchNodeStatus,
    /**
     * The academy level this node's tier needs, **always** present and stated
     * plainly — the third acceptance criterion. Sent even once it is met, so the
     * tree can label every tier with what opened it.
     */
    requiredAcademyLevel: AcademyLevel,
    /** §10.1's name for that level: *"Requires a Flight Academy (level 3)"*. */
    requiredAcademyName: z.string().min(1),
    /**
     * What a `POST` would answer right now, or null when it would start.
     *
     * The server's verdict rather than one the client reconstructs, so the
     * button and the refusal can never disagree. Null on a complete or running
     * node as well: there is nothing to start.
     */
    startRefusal: ResearchRefusal.nullable(),
    /** Game time. Null until started. */
    startedAt: Timestamp.nullable(),
    /** Game time. Complete exactly when the world's clock has passed it. */
    completesAt: Timestamp.nullable(),
  })
  .strict();
export type ResearchNodeView = z.infer<typeof ResearchNodeView>;

export const ResearchBranchView = z
  .object({
    branch: ResearchBranch,
    name: z.string().min(1),
    summary: z.string().min(1),
    /** Tier 1 first. */
    nodes: z.array(ResearchNodeView),
  })
  .strict();
export type ResearchBranchView = z.infer<typeof ResearchBranchView>;

export const ResearchResponse = z
  .object({
    /**
     * Research points, which §10.3 says cannot be bought — and nothing here can
     * spend cash on them. Fractional: a short sector at a small academy earns a
     * fraction of a point, and rounding each one away would starve exactly the
     * airlines the formula is meant to be slow for, not stop.
     */
    points: z
      .object({
        balance: z.number().min(0),
        earnedTotal: z.number().min(0),
        /** Points earned over the last seven game days, per day. An observation. */
        recentPerDay: z.number().min(0),
      })
      .strict(),
    /**
     * §10.3's formula and the airline's own numbers in it:
     * `RP/day = Σ(academy levels) × academyStaffQuality × (fleet flight hours ÷ scalingFactorHours)`.
     *
     * Sent so the tree can explain the rate rather than assert it — and so a
     * large airline with no academy can see why it earns nothing.
     */
    formula: z
      .object({
        academyLevelSum: z.number().int().min(0),
        academyStaffQuality: z.number().positive(),
        scalingFactorHours: z.number().positive(),
      })
      .strict(),
    academy: z
      .object({
        /** The highest commissioned academy level the airline holds. 0 with none. */
        highestLevel: AcademyCommissionedLevel,
        /** The tier that level opens. Null with no commissioned academy. */
        researchTier: ResearchTier.nullable(),
      })
      .strict(),
    branches: z.array(ResearchBranchView),
    /** The one node being researched, if any. */
    active: z
      .object({ nodeId: ResearchNodeId, startedAt: Timestamp, completesAt: Timestamp })
      .strict()
      .nullable(),
    /** The world's game clock when this was read, for countdowns in game time. */
    gameNow: Timestamp,
  })
  .strict();
export type ResearchResponse = z.infer<typeof ResearchResponse>;

export const StartResearchInput = z.object({ nodeId: ResearchNodeId }).strict();
export type StartResearchInput = z.infer<typeof StartResearchInput>;
