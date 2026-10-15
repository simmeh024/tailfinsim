import {
  ACADEMY_LEVELS,
  ACADEMY_MODULES,
  type AcademiesResponse,
  type AcademyBuildQuote,
  type AcademyCeiling,
  type AcademyModuleKind,
  type AcademyModuleOffer,
  type AcademyRefusal,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { AcademyFailure } from './academy-api';

/**
 * How the academies section says what it says (SURFACE-10).
 *
 * Pure, and apart from the component for the reason `maintenance-presentation`
 * is: every sentence here is a claim about a building the player is paying for,
 * and the claims worth testing are the ones a careless render gets wrong — a
 * building site read as level 1, a stalled build read as a slow one, an inert
 * module sold as a working one, and an academy described as making the airline
 * more popular.
 *
 * ## Nothing here computes a figure the server owns
 *
 * Capital, build weeks, upkeep, slots and the outsourced rate arrive in the
 * response and are formatted, never derived. The level names and what each
 * level opens are §10.1's **design** table, which `@tailfin/shared` holds and
 * the server reads too; no **balance** number is in this file.
 *
 * ## What an academy is allowed to be said to do (§10.4)
 *
 * *"Boosts are operational efficiency, never demand or money directly. They
 * make you cheaper and faster, not more popular."* An academy is a ceiling and
 * a discount: it lowers what a conversion costs, permits higher ranks and
 * research tiers, and its levels count toward research points. Nothing on the
 * page may say it moves demand, fares or reputation — a test reads every
 * sentence below for those words.
 */

const GAME_MINUTE_MS = 60_000;
const GAME_DAY_MS = 86_400_000;

/**
 * How long past its promised instant a build must be before the page calls it
 * stalled.
 *
 * Builds are commissioned on the worker's next tick after their game-time
 * completion. An hour of game time is far past any tick a running worker would
 * miss and far short of the weeks a build takes — the threshold
 * `CHECK_STALLED_AFTER_GAME_MINUTES` uses for a maintenance check, for the same
 * reason. A display threshold: it decides nothing the game acts on.
 */
export const BUILD_STALLED_AFTER_GAME_MINUTES = 60;

/** A cash figure in the player's display currency, whole units, as the crew page shows one. */
export function money(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

/** `2025-01-04` — UTC, as everywhere else that shows a world date. */
export function formatWorldDate(iso: string): string {
  return iso.slice(0, 10);
}

/** `4 game weeks`, `1 game week`. The world's calendar, never the browser's (ADR-0026). */
export function gameWeeks(weeks: number): string {
  return `${String(weeks)} game week${weeks === 1 ? '' : 's'}`;
}

/** §10.1's name for a level. Design, not balance — the table the server reads too. */
export function levelName(level: number): string {
  return ACADEMY_LEVELS.find((row) => row.level === level)?.name ?? `Level ${String(level)}`;
}

/** What a level opens, in §10.1's words: the ceiling, and nothing but the ceiling. */
export function levelUnlocksInWords(level: number): string {
  const row = ACADEMY_LEVELS.find((entry) => entry.level === level);
  if (row === undefined) return '';
  const deck =
    row.flightDeckUpTo === null
      ? 'no flight deck'
      : `flight deck up to ${CREW_RANK_LABEL[row.flightDeckUpTo]}`;
  return `${row.unlocks}. Trains ${deck} and cabin up to ${CREW_RANK_LABEL[row.cabinUpTo]}; opens research tier ${String(row.researchTier)}.`;
}

/** A module's §10.1 name, from the design table. */
export function moduleName(kind: AcademyModuleKind): string {
  return ACADEMY_MODULES.find((row) => row.kind === kind)?.name ?? kind.replaceAll('_', ' ');
}

/** The rows of an academy's ceiling, as label and value. The server's figures throughout. */
export function ceilingRows(ceiling: AcademyCeiling): { label: string; value: string }[] {
  return [
    {
      label: 'Flight deck up to',
      // Null at level 1, and that is §10.1's reading of "Basic CBT, induction":
      // a training room is not where a first officer is made.
      value: ceiling.flightDeckUpTo === null ? 'None yet' : CREW_RANK_LABEL[ceiling.flightDeckUpTo],
    },
    { label: 'Cabin up to', value: CREW_RANK_LABEL[ceiling.cabinUpTo] },
    { label: 'Research tier', value: `Up to tier ${String(ceiling.researchTier)}` },
    {
      label: 'Training slots',
      value: `${String(ceiling.slotsInUse)} of ${String(ceiling.trainingSlots)} in use`,
    },
  ];
}

/** Whole game days from `gameNow` to `readyAt`, rounded up; null when either is unreadable. */
export function gameDaysUntil(readyAt: string, gameNow: Date | null): number | null {
  if (gameNow === null) return null;
  const end = Date.parse(readyAt);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - gameNow.getTime()) / GAME_DAY_MS));
}

/**
 * True when a build is well past its promised instant and nothing has finished it.
 *
 * Builds are the worker's to finish; a node with no worker leaves an academy a
 * permanent building site, which otherwise reads as a long build rather than as
 * a missing process. `gameNow` null (the clock has not synced) never claims a
 * stall.
 */
export function isBuildStalled(readyAt: string, gameNow: Date | null): boolean {
  if (gameNow === null) return false;
  const due = Date.parse(readyAt);
  if (!Number.isFinite(due)) return false;
  return gameNow.getTime() - due > BUILD_STALLED_AFTER_GAME_MINUTES * GAME_MINUTE_MS;
}

export interface BuildProgress {
  tone: 'building' | 'due' | 'stalled';
  text: string;
}

/**
 * A build in words, on the world's clock.
 *
 * Without a synced clock this says the date and nothing about how far off it is,
 * rather than measuring game time against the browser's — a dash is a smaller
 * lie than a number wrong by the world's speed.
 */
export function buildProgressInWords(readyAt: string, gameNow: Date | null): BuildProgress {
  const date = formatWorldDate(readyAt);
  if (isBuildStalled(readyAt, gameNow)) {
    return {
      tone: 'stalled',
      text: `Was due on ${date} and has not finished. Builds are completed by the world’s worker, and none has run since — it stays a building site until one does.`,
    };
  }
  const days = gameDaysUntil(readyAt, gameNow);
  if (days === null) return { tone: 'building', text: `Ready ${date}, world time.` };
  if (days === 0) return { tone: 'due', text: `Due ${date} — finishes on the world’s next tick.` };
  return {
    tone: 'building',
    text: `Ready ${date}, ${String(days)} game day${days === 1 ? '' : 's'} from now.`,
  };
}

/** Why a module offer cannot be built now, or null when it can. The server's `blockedBy`. */
export function blockedInWords(offer: AcademyModuleOffer): string | null {
  switch (offer.blockedBy) {
    case null:
      return null;
    case 'level':
      return `From level ${String(offer.fromLevel)} (${levelName(offer.fromLevel)})`;
    case 'already_built':
      return offer.perFamily ? 'Built for every family this world flies' : 'Built';
    case 'under_construction':
      return 'Being built';
  }
}

/** `a CBT Suite`, `an Emergency & Wet Drill`. */
function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** What one write would do, for the confirmation step. */
export type AcademyIntent =
  | { kind: 'found'; crewBaseId: string; icao: string; quote: AcademyBuildQuote }
  | {
      kind: 'level';
      academyId: string;
      icao: string;
      level: number;
      quote: AcademyBuildQuote;
    }
  | {
      kind: 'module';
      academyId: string;
      icao: string;
      module: AcademyModuleKind;
      family: string | null;
      readToday: boolean;
      quote: AcademyBuildQuote;
    };

/** Where an intent's confirmation is drawn: beside the control that raised it. */
export function intentKey(intent: AcademyIntent): string {
  switch (intent.kind) {
    case 'found':
      return `found:${intent.crewBaseId}`;
    case 'level':
      return `level:${intent.academyId}`;
    case 'module':
      return `module:${intent.academyId}:${intent.module}`;
  }
}

/**
 * The confirmation, stated before anything is paid.
 *
 * Every figure is the quote the server sent with the state on screen. The
 * build cannot be shortened with money — no lever exists — and nothing built
 * can be sold or taken down, so both are said here rather than discovered.
 */
export function confirmInWords(intent: AcademyIntent): string {
  const { capitalCostMinor, buildWeeks, monthlyUpkeepMinor } = intent.quote;
  switch (intent.kind) {
    case 'found':
      return `Found an academy at ${intent.icao}: ${money(capitalCostMinor)} now, and level 1 (${levelName(1)}) opens in ${gameWeeks(buildWeeks)}. From then it costs ${money(monthlyUpkeepMinor)} a game month in upkeep. Nothing shortens the build, and an academy cannot be sold or demolished.`;
    case 'level':
      return `Build level ${String(intent.level)} (${levelName(intent.level)}) at ${intent.icao}: ${money(capitalCostMinor)} now, commissioned in ${gameWeeks(buildWeeks)}. The building’s upkeep then becomes ${money(monthlyUpkeepMinor)} a game month, in place of this level’s. Nothing shortens the build, and a level cannot be taken down.`;
    case 'module': {
      const what =
        intent.family === null
          ? moduleName(intent.module)
          : `${moduleName(intent.module)} for the ${intent.family}`;
      const inert = intent.readToday
        ? ''
        : ' Nothing in the game uses this module yet: you would be paying for a room that teaches nothing today.';
      return `Build ${withArticle(what)} at ${intent.icao}: ${money(capitalCostMinor)} now, installed in ${gameWeeks(buildWeeks)}, then ${money(monthlyUpkeepMinor)} a game month on top of the academy’s upkeep.${inert}`;
    }
  }
}

/** What the player can do about a refusal, keyed by the server's closed set. */
const REFUSAL_HINT: Record<AcademyRefusal, string> = {
  insufficient_funds:
    'The capital is paid in full when construction starts, so this waits until the airline holds it.',
  already_building: 'One build at a time: the next level can start once this one is commissioned.',
  max_level: 'A Centre of Excellence is the top of the ladder.',
  module_exists: 'That module is already built, or being built, here.',
  module_level: 'Raise the academy to the level this module needs first.',
  unknown_family: 'Choose a family this world flies.',
  academy_exists: 'One academy per crew base, and this base has one.',
  base_closed: 'An academy is founded at an open crew base.',
  base_absent: 'That crew base is not one of yours. Reload to see your bases as they are.',
  academy_absent: 'That academy could not be found. Reload to see your academies as they are.',
};

function isAcademyRefusal(code: string): code is AcademyRefusal {
  return code in REFUSAL_HINT;
}

/**
 * A refusal in words: the server's message, what would fix it, and the
 * guarantee the refused write leaves behind.
 *
 * *"Nothing was charged"* is a claim, and `academy/routes-refusals.test.ts`
 * proves it at the API boundary for every code in the closed set — cash, the
 * movements, the ledger and the academies, unchanged.
 */
export function refusalInWords(refusal: AcademyFailure): string {
  const hint = isAcademyRefusal(refusal.code) ? ` ${REFUSAL_HINT[refusal.code]}` : '';
  const message = refusal.message.endsWith('.') ? refusal.message : `${refusal.message}.`;
  return `${message}${hint} Nothing was charged and nothing changed.`;
}

/**
 * What an academy changes, in §10.4's terms: cheaper, never more popular.
 *
 * The outsourced rate is the server's; the in-house rate is the economy's and is
 * not on the wire, so the page says "a fraction of" — §10.1's own words —
 * rather than computing a saving from a number it does not have.
 */
export function academyPurposeInWords(outsourcedPerHeadMinor: number): string {
  return `A conversion trained without an academy is bought in at ${money(outsourcedPerHeadMinor)} a head. One trained in-house — at a base whose academy level permits the rank, with a CBT Suite, the module for the crew’s line and enough free training slots — costs a fraction of that. Levels set how far crew can be trained, open research tiers and count toward research points. An academy makes the airline cheaper to run, not more popular.`;
}

/**
 * What a write did, read back out of the state the server answered with — the
 * promised date is the server's, never the quote's weeks added to a clock here.
 */
export function doneInWords(intent: AcademyIntent, state: AcademiesResponse): string {
  switch (intent.kind) {
    case 'found': {
      const founded = state.academies.find((row) => row.crewBaseId === intent.crewBaseId);
      return founded?.constructionReadyAt
        ? `Academy founded at ${intent.icao}: level 1 is under construction, ready ${formatWorldDate(founded.constructionReadyAt)}, world time.`
        : `Academy founded at ${intent.icao}.`;
    }
    case 'level': {
      const academy = state.academies.find((row) => row.id === intent.academyId);
      return academy?.constructionReadyAt
        ? `Level ${String(intent.level)} started at ${intent.icao}: ready ${formatWorldDate(academy.constructionReadyAt)}, world time.`
        : `Level ${String(intent.level)} started at ${intent.icao}.`;
    }
    case 'module': {
      const academy = state.academies.find((row) => row.id === intent.academyId);
      const module = academy?.modules.find(
        (row) =>
          row.kind === intent.module &&
          row.family === intent.family &&
          row.status === 'under_construction',
      );
      const what =
        intent.family === null
          ? moduleName(intent.module)
          : `${moduleName(intent.module)} for the ${intent.family}`;
      return module === undefined
        ? `${what} started at ${intent.icao}.`
        : `${what} started at ${intent.icao}: installed ${formatWorldDate(module.readyAt)}, world time.`;
    }
  }
}
