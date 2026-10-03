import {
  EFFICIENCY_QUANTITY_LABELS,
  RESEARCH_NODES,
  type ResearchEffectTarget,
  type ResearchEffectView,
  type ResearchNodeId,
  type ResearchNodeView,
  type ResearchRefusal,
  type ResearchResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

/**
 * The research tree's words and figures (M9-05, §10.3, §10.5).
 *
 * Pure folds over what the server sent: no function here decides whether a node
 * may start, what it costs or how many points accrue. They turn a refusal code
 * into a sentence, a fraction into "−1.5% fuel burn" and two game instants into
 * a countdown — presentation, which is the client's, and nothing else.
 *
 * §10.5's line is the brief for most of it: locked tiers, subdued, *"with the
 * facility level required stated plainly."* Plainly means in words, beside the
 * node, for every tier — not a padlock and a tooltip.
 */

/** One game day, in milliseconds of the world's own calendar (ADR-0026). */
const GAME_DAY_MS = 86_400_000;

/**
 * Every target a node can make better, named.
 *
 * §10.4's six come from `EFFICIENCY_QUANTITY_LABELS` so the tree and M9-06's
 * readout can never name a quantity two ways; `crewXp` is the seventh, the rate
 * crew learn, which only the Crew Development branch reaches.
 */
export const RESEARCH_EFFECT_LABELS: Record<ResearchEffectTarget, string> = {
  ...EFFICIENCY_QUANTITY_LABELS,
  crewXp: 'Crew XP',
};

/**
 * The refusals, as a set the client can check a code against.
 *
 * A `Record` keyed by the type rather than the zod enum's `options`, so the
 * schema stays out of the bundle and a ninth refusal added to the contract is a
 * type error here until it has words below.
 */
const KNOWN_REFUSALS: Record<ResearchRefusal, true> = {
  academy_level: true,
  prerequisite: true,
  not_released: true,
  already_complete: true,
  already_in_progress: true,
  project_running: true,
  insufficient_points: true,
  insufficient_funds: true,
};

export function isResearchRefusal(code: string): code is ResearchRefusal {
  return Object.hasOwn(KNOWN_REFUSALS, code);
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** `0.015` → `1.5%`, `0.04` → `4%`, `0.0125` → `1.25%`. No trailing zeros. */
export function formatPercent(fraction: number): string {
  return `${String(Number((fraction * 100).toFixed(2)))}%`;
}

/**
 * One effect, in words: `−1.5% fuel burn`, `−4% turnaround time`, `+5% crew XP`.
 *
 * The sign is the direction the player feels. §10.4's six are costs and
 * durations a doctrine *removes*, so they read as a reduction; crew XP is a rate
 * it *adds* to. The minus is U+2212, the typographic one, so it does not read as
 * a hyphen in a figure.
 */
export function effectInWords(effect: ResearchEffectView): string {
  const sign = effect.target === 'crewXp' ? '+' : '−';
  return `${sign}${formatPercent(effect.fraction)} ${lowerFirst(RESEARCH_EFFECT_LABELS[effect.target])}`;
}

/**
 * What an unreleased node *aims at*, from the catalogue.
 *
 * The response sends no effects for a node outside this release — the amount is
 * balance nobody has set — but which quantity it makes better is design and is
 * in `@tailfin/shared`. So the tree can still say *"fuel burn, block time"* for a
 * tier 4 node without inventing a percentage. An empty list is a capability no
 * system models yet (ETOPS authority, in-house heavy checks).
 */
export function catalogueTargets(id: ResearchNodeId): readonly ResearchEffectTarget[] {
  return RESEARCH_NODES.find((node) => node.id === id)?.targets ?? [];
}

export function targetsInWords(targets: readonly ResearchEffectTarget[]): string {
  return targets.map((target) => lowerFirst(RESEARCH_EFFECT_LABELS[target])).join(', ');
}

/**
 * Research points, to one decimal place, **rounded down**.
 *
 * One decimal everywhere — the balance, the rate and every cost — so a column of
 * points reads the same way throughout. Down rather than to nearest, because a
 * balance of 119.96 shown as `120.0` beside a cost of `120.0` would invite a
 * click the server refuses. A positive rate too small to show is `< 0.1`, not
 * `0.0`: §10.3's whole point is that a slow airline earns *slowly*, and a zero
 * would say it earns nothing.
 */
export function formatPoints(points: number): string {
  const tenths = Math.floor(points * 10 + 1e-9) / 10;
  if (points > 0 && tenths === 0) return '< 0.1';
  return tenths.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** A cash cost in the player's display currency, whole units — as the crew page shows one. */
export function formatCash(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

/** `4 game weeks`, `1 game week`. The world's calendar, never the browser's (ADR-0026). */
export function formatGameWeeks(weeks: number): string {
  return `${String(weeks)} game week${weeks === 1 ? '' : 's'}`;
}

/** `2025-01-04` — UTC, as everywhere else that shows a world date. */
export function formatGameDate(iso: string): string {
  return iso.slice(0, 10);
}

/** §10.3's academy staff quality, as the multiplier it is in the formula. */
export function formatStaffQuality(quality: number): string {
  return quality.toFixed(2);
}

export function formatHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
}

/**
 * Whole game days left, rounded up — or null when either instant is unreadable.
 *
 * Measured from `gameNow`, the world's clock as the server read it with this
 * response, never from `Date.now()`: a project's weeks are the world's, and the
 * browser's clock would be wrong by the world's speed multiplier.
 */
export function gameDaysRemaining(gameNow: string, completesAt: string): number | null {
  const now = Date.parse(gameNow);
  const end = Date.parse(completesAt);
  if (!Number.isFinite(now) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now) / GAME_DAY_MS));
}

/** `3 game weeks, 2 game days remaining`, `5 game days remaining`, `Due to complete`. */
export function remainingInWords(days: number): string {
  if (days <= 0) return 'Due to complete';
  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  const parts: string[] = [];
  if (weeks > 0) parts.push(formatGameWeeks(weeks));
  if (rest > 0) parts.push(`${String(rest)} game day${rest === 1 ? '' : 's'}`);
  return `${parts.join(', ')} remaining`;
}

/** How far through a project is, 0–1, on the world's clock. Null when it cannot be said. */
export function progressFraction(
  startedAt: string,
  completesAt: string,
  gameNow: string,
): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(completesAt);
  const now = Date.parse(gameNow);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now)) return null;
  if (end <= start) return null;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/**
 * The third acceptance criterion, word for word: *"Requires a Flight Academy —
 * academy level 3"*. Every node carries it whether or not it is met, so the tree
 * can label each tier with what opens it.
 */
export function academyRequirement(
  node: Pick<ResearchNodeView, 'requiredAcademyName' | 'requiredAcademyLevel'>,
): string {
  return `Requires ${withArticle(node.requiredAcademyName)} — academy level ${String(node.requiredAcademyLevel)}`;
}

/** What the airline holds against that requirement. */
export function academyHeldInWords(highestLevel: number): string {
  return highestLevel === 0
    ? 'You have no commissioned academy'
    : `Your highest academy is level ${String(highestLevel)}`;
}

export function allNodes(research: ResearchResponse): ResearchNodeView[] {
  return research.branches.flatMap((branch) => branch.nodes);
}

export function nodeById(
  research: ResearchResponse,
  id: ResearchNodeId,
): ResearchNodeView | undefined {
  return allNodes(research).find((node) => node.id === id);
}

/** The node one tier below in the same branch — the one a `prerequisite` refusal is about. */
export function prerequisiteOf(
  research: ResearchResponse,
  node: Pick<ResearchNodeView, 'branch' | 'tier'>,
): ResearchNodeView | undefined {
  return allNodes(research).find((row) => row.branch === node.branch && row.tier === node.tier - 1);
}

/**
 * Why a node cannot start, as a sentence to put beside it.
 *
 * Each sentence points at the control that fixes it, which is why the codes are
 * a closed set in the first place: `academy_level` is *build a bigger academy*,
 * `prerequisite` is *research the tier below*, `insufficient_points` is *fly
 * more, or wait* — and nothing says *buy points*, because nothing can.
 */
export function refusalInWords(
  refusal: ResearchRefusal,
  node: ResearchNodeView,
  research: ResearchResponse,
): string {
  switch (refusal) {
    case 'academy_level':
      return `Needs ${withArticle(node.requiredAcademyName)} (academy level ${String(node.requiredAcademyLevel)}) to open tier ${String(node.tier)}. ${academyHeldInWords(research.academy.highestLevel)}.`;
    case 'not_released':
      return 'Arrives in a later release. Its cost is shown so you can see what it will take.';
    case 'prerequisite': {
      const below = prerequisiteOf(research, node);
      return below === undefined
        ? 'Research the tier below in this branch first.'
        : `Research ${below.name} first.`;
    }
    case 'already_complete':
      return 'Already researched.';
    case 'already_in_progress':
      return 'Already being researched.';
    case 'project_running': {
      const running =
        research.active === null ? undefined : nodeById(research, research.active.nodeId);
      return running === undefined
        ? 'Another project is running. One project at a time, airline-wide.'
        : `${running.name} is being researched. One project at a time, airline-wide.`;
    }
    case 'insufficient_points':
      return `Needs ${formatPoints(node.cost.researchPoints)} RP; you have ${formatPoints(research.points.balance)} RP. Points come only from academies and flying.`;
    case 'insufficient_funds':
      return `Needs ${formatCash(node.cost.cashMinor)} in cash, which the airline does not have.`;
  }
}

/**
 * Why nothing is accruing, or null when something is.
 *
 * §10.3: *"A big airline that never built academies generates almost none —
 * size alone doesn't buy competence."* The formula is a product, so an airline
 * with no academy earns exactly zero however much it flies, and a bare `0.0`
 * would read as a fault. This says which factor is zero and what changes it.
 */
export function accrualExplanation(research: ResearchResponse): string | null {
  if (research.formula.academyLevelSum === 0) {
    return 'Nothing accrues: with no commissioned academy the sum of academy levels is 0, so the whole formula is 0 however much you fly. Build a training academy at one of your crew bases — every level it reaches adds to the sum. Size alone does not buy competence.';
  }
  if (research.points.recentPerDay === 0) {
    return 'Your academies count, but nothing earned points over the last seven game days. Fleet flight hours are the other factor: points accrue as the fleet flies.';
  }
  return null;
}
