import type {
  GroundContractAlert,
  GroundContractView,
  GroundServiceLine,
  GroundVendorOfferView,
  HandlerGrade,
} from '@tailfin/shared';

/**
 * How the ground handling view says what it says (SURFACE-05).
 *
 * Pure, so the sentences that a careless render gets wrong are tested on their
 * own: a null term read as *expired*, a term past its end on a world nothing is
 * lapsing read as *active*, a full vendor read as an error.
 *
 * **No figure here is computed from the economy.** Capacities, indices, terms
 * and penalties arrive from the server; this formats them, and does only the
 * arithmetic of turning game days into the real time a world's speed implies.
 */

const GAME_DAY_MS = 86_400_000;
const GAME_MINUTE_MS = 60_000;

/**
 * How far past its term a contract has to be before the page says nothing is
 * lapsing it.
 *
 * `expireGroundContracts` runs on the worker's tick, a few game minutes apart at
 * any world speed; an hour of game time past the end is far beyond a tick a
 * running worker would miss. A display threshold — it decides nothing.
 */
export const TERM_OVERDUE_AFTER_GAME_MINUTES = 60;

export const SERVICE_LINE_LABEL: Record<GroundServiceLine, string> = {
  ramp_baggage: 'Ramp and baggage',
  fuelling: 'Fuelling',
  catering: 'Catering',
  cleaning: 'Cleaning',
  pushback: 'Pushback',
  deicing: 'De-icing',
};

export const GRADE_LABEL: Record<HandlerGrade, string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
};

export type Tone = 'neutral' | 'positive' | 'negative' | 'warn';

export interface TermPresentation {
  label: string;
  tone: Tone;
  detail: string;
}

/** `2027-03-14`: the world's date, UTC, as every page shows one. */
export function formatWorldDate(iso: string): string {
  return iso.slice(0, 10);
}

function plural(value: number, one: string, many: string): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${value === 1 ? one : many}`;
}

/**
 * A span of game time as the world counts it and as the player will wait it.
 *
 * `term_end` is **game** time (ADR-0026), so a 4× world reaches it in a quarter
 * of the real time a 1× world would — the same 30 game days are 15 real days at
 * 2× and 7.5 at 4×. Saying both is what makes a term legible: the world date is
 * when it ends in the game, and the real days are when the player has to be back.
 */
export function spanInWords(gameMs: number, speedMultiplier: number | null): string {
  const days = Math.max(0, gameMs) / GAME_DAY_MS;
  const game = plural(Math.ceil(days), 'game day', 'game days');
  if (speedMultiplier === null || !(speedMultiplier > 0)) return game;
  const real = Math.round((days / speedMultiplier) * 10) / 10;
  return `${game} — about ${plural(real, 'real day', 'real days')} at ${String(speedMultiplier)}×`;
}

type Arrangement = Pick<GroundContractView, 'kind' | 'termEnd' | 'expiring'>;

/**
 * What a contract's term means, in words.
 *
 * Four answers, and two of them are traps the issue names:
 *
 *   - **A null `term_end` is a legacy contract that never lapses**, not one
 *     that lapsed at the epoch (CLAUDE.md). Rendering it as expired would tell
 *     every holder of a pre-term contract that their handling had gone.
 *   - **A term past its end that is still listed** means the worker has not
 *     lapsed it — on a node with no worker, never will. It is told apart from an
 *     active one, because a contract that should have freed its vendor slot and
 *     has not reads as a frozen market rather than as a missing process.
 *
 * Self-handling has no term at all: there is no counterparty to have agreed one.
 */
export function termPresentation(
  arrangement: Arrangement,
  gameNow: Date | null,
  speedMultiplier: number | null,
): TermPresentation {
  if (arrangement.kind === 'self') {
    return {
      label: 'No term',
      tone: 'neutral',
      detail: 'Your own staff: there is no counterparty, so nothing lapses.',
    };
  }
  if (arrangement.termEnd === null) {
    return {
      label: 'No term',
      tone: 'neutral',
      detail: 'Signed before contracts had terms. It does not lapse.',
    };
  }

  const end = Date.parse(arrangement.termEnd);
  const date = formatWorldDate(arrangement.termEnd);
  if (gameNow !== null && Number.isFinite(end)) {
    const past = gameNow.getTime() - end;
    if (past > TERM_OVERDUE_AFTER_GAME_MINUTES * GAME_MINUTE_MS) {
      return {
        label: 'Past its term',
        tone: 'negative',
        detail: `Its term ended on ${date}. It should have lapsed back to walk-up handling and freed the vendor’s slot; terms are lapsed by the world’s worker, and none has run since.`,
      };
    }
    const left = spanInWords(end - gameNow.getTime(), speedMultiplier);
    return arrangement.expiring
      ? { label: 'Lapsing soon', tone: 'warn', detail: `Ends ${date}, in ${left}.` }
      : { label: 'Active', tone: 'positive', detail: `Ends ${date}, in ${left}.` };
  }
  return arrangement.expiring
    ? { label: 'Lapsing soon', tone: 'warn', detail: `Ends ${date}.` }
    : { label: 'Active', tone: 'positive', detail: `Ends ${date}.` };
}

/** Slots left at a grade. Never negative, whatever the counts say. */
export function freeSlots(offer: Pick<GroundVendorOfferView, 'capacity' | 'taken'>): number {
  return Math.max(0, offer.capacity - offer.taken);
}

/**
 * A vendor's scarcity, said as the market fact it is.
 *
 * Capacity counts only *active* contracts, so a rival's contract genuinely
 * denies a slot and an expiry genuinely frees one. A full vendor is not an error
 * and is not drawn as one.
 */
export function scarcityInWords(offer: GroundVendorOfferView): string {
  const free = freeSlots(offer);
  if (free === 0) {
    return `Full — all ${String(offer.capacity)} slots are held by airlines in this world. One frees when a contract ends or lapses.`;
  }
  return `${String(free)} of ${String(offer.capacity)} slots free`;
}

/** `0.94` reliability as `94%`, a multiplier as `×1.10`. */
export function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

export function multiplier(value: number): string {
  return `×${value.toFixed(2)}`;
}

/**
 * Where a volume commitment stands: `52 of 63 departures flown`, or
 * `not measured` for a contract signed before terms were priced.
 */
export function commitmentInWords(
  alert: Pick<GroundContractAlert, 'committedDepartures' | 'departuresFlown'>,
): string {
  if (alert.committedDepartures === null) return '—';
  if (alert.departuresFlown === null) return 'not measured';
  return `${String(alert.departuresFlown)} of ${String(alert.committedDepartures)} departures flown`;
}
