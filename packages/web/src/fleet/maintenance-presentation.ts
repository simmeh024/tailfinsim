import type {
  CheckTier,
  MaintenanceAirframeView,
  MaintenanceResponse,
  MaintenanceTierView,
} from '@tailfin/shared';

/**
 * How the maintenance planner says what it says (SURFACE-04).
 *
 * Pure, and kept apart from the component for the reason `research-presentation`
 * is: every sentence here is a claim about the aeroplane, and the claims worth
 * testing are the ones a careless render would get wrong — the null history read
 * as zero, a stalled check read as a running one, a hold state the game adds
 * later read as nothing at all.
 *
 * **Nothing here computes a figure the server owns.** Hours and cycles remaining,
 * cost and downtime arrive in the response and are formatted, never derived.
 */

const GAME_MINUTE_MS = 60_000;

/**
 * How long past its completion a check must be before the page calls it stalled.
 *
 * A check completes on the worker's next tick after its game-time completion,
 * and at 4× a tick a few real seconds late is a few game minutes. An hour of game
 * time is far past any tick a running worker would miss, and far short of the
 * days a check lasts — so it separates *about to finish* from *nothing is going
 * to finish it*. A display threshold: it decides nothing the game acts on.
 */
export const CHECK_STALLED_AFTER_GAME_MINUTES = 60;

export const TIER_LABEL: Record<CheckTier, string> = {
  a: 'A-check',
  c: 'C-check',
  d: 'D-check',
};

/** A tone the shell's `.status--*` classes carry, each with its own glyph (H.7). */
export type StatusTone = 'ontime' | 'delayed' | 'cancelled';

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** The sentence beside the label, or null when the label says it all. */
  detail: string | null;
}

/** `2027-03-14`: the world's date, UTC, as every page shows one. */
export function formatWorldDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Whether a running check has passed its completion on the world's clock with
 * nothing to complete it.
 *
 * Checks complete on the **worker's** tick (M4-06). A node with no worker never
 * runs it, so an aeroplane booked in there stays `in_check` for ever — and a page
 * that went on saying "in check" would read as a long check rather than as a
 * missing process. `gameNow` null (the clock has not synced) never claims a stall.
 */
export function isCheckStalled(view: MaintenanceAirframeView, gameNow: Date | null): boolean {
  if (view.status !== 'in_check' || view.checkCompletesAt === null || gameNow === null) {
    return false;
  }
  const due = Date.parse(view.checkCompletesAt);
  if (!Number.isFinite(due)) return false;
  return gameNow.getTime() - due > CHECK_STALLED_AFTER_GAME_MINUTES * GAME_MINUTE_MS;
}

/**
 * What an airframe's status means, in words.
 *
 * Three states today and **room for a fourth**: SAFETY-05 will add a regulatory
 * hold that composes with both a check and a grounding. A status this build does
 * not know is drawn as a hold with its own name rather than as nothing, so a
 * newer server can never make an aeroplane that cannot fly look as if it can.
 */
export function statusPresentation(
  view: MaintenanceAirframeView,
  gameNow: Date | null,
): StatusPresentation {
  const status: string = view.status;
  switch (status) {
    case 'in_service':
      return { label: 'In service', tone: 'ontime', detail: null };
    case 'in_check': {
      const tier = view.checkTier === null ? 'Check' : TIER_LABEL[view.checkTier];
      if (view.checkCompletesAt === null) {
        return { label: 'In check', tone: 'delayed', detail: `${tier} under way.` };
      }
      const back = formatWorldDate(view.checkCompletesAt);
      if (isCheckStalled(view, gameNow)) {
        return {
          label: 'Check not completing',
          tone: 'cancelled',
          detail: `${tier} was due to finish on ${back} and has not. Checks are completed by the world’s worker, and none has run since — the aircraft stays out of service until one does.`,
        };
      }
      return { label: 'In check', tone: 'delayed', detail: `${tier} — back in service ${back}.` };
    }
    case 'grounded':
      return {
        label: 'Grounded',
        tone: 'cancelled',
        detail:
          'Flown too far past a check. It cannot fly until the work is booked — a grounded aircraft can still be booked in.',
      };
    default:
      return {
        label: 'Held',
        tone: 'cancelled',
        detail: `Out of service (${status.replaceAll('_', ' ')}).`,
      };
  }
}

function whole(value: number): string {
  return Math.round(Math.abs(value)).toLocaleString('en-US');
}

/**
 * When a tier falls due, by the limit that binds: `in 120 h`, `in 40 cycles`,
 * `180 h overdue`.
 *
 * The **server's** remaining figures, as sent. For an airframe whose history was
 * never recorded they are already counted from the hours it has now, which is
 * the whole of SURFACE-04's fourth point: this function has no way to render a
 * missing history as zero, because it never sees one.
 */
export function dueInWords(tier: MaintenanceTierView): string {
  const remaining = tier.binding === 'hours' ? tier.hoursRemaining : tier.cyclesRemaining;
  const unit =
    tier.binding === 'hours' ? 'h' : remaining === 1 || remaining === -1 ? 'cycle' : 'cycles';
  if (remaining < 0) return `${whole(remaining)} ${unit} overdue`;
  if (tier.due) return 'due now';
  return `in ${whole(remaining)} ${unit}`;
}

/** The tier falling due soonest, by how much of its interval is used. */
export function nextTier(view: MaintenanceAirframeView): MaintenanceTierView | null {
  let best: MaintenanceTierView | null = null;
  for (const tier of view.tiers) {
    if (best === null || tier.usedFraction > best.usedFraction) best = tier;
  }
  return best;
}

/**
 * How the airframe's history is counted, said out loud.
 *
 * `historyRecorded` false means `maintenance_state` is null, which the server
 * reads as **every tier last completed at the hours this airframe has now** —
 * not at hour zero (CLAUDE.md, `docs/maintenance.md`). Saying so is the
 * difference between a player trusting the figures and a player believing a
 * 24,000-hour airframe has somehow never needed a check.
 */
export function historyInWords(view: MaintenanceAirframeView): string | null {
  if (view.historyRecorded) return null;
  return `No maintenance history recorded: every check counts as last completed at the ${whole(view.totalHours)} h and ${whole(view.totalCycles)} cycles it has now, so nothing is overdue from before it was tracked.`;
}

/** One tier of one airframe, for the fleet-wide list of what is coming due. */
export interface ComingDue {
  view: MaintenanceAirframeView;
  tier: MaintenanceTierView;
}

/**
 * The fleet's next checks, most used interval first.
 *
 * The planning view SURFACE-04 asks for: *"one aeroplane's next check is a
 * detail, the fleet's next six are a schedule."* Aircraft already in a check are
 * left out — the decision has been taken — and so is a lighter tier while a
 * heavier one on the same airframe is due, because a D-check covers the C and A
 * work and booking both would be paying twice.
 */
export function comingDue(response: MaintenanceResponse, limit = 6): ComingDue[] {
  const rows: ComingDue[] = [];
  for (const view of response.airframes) {
    if (view.status === 'in_check') continue;
    const heaviestDue = view.dueTiers[0] ?? null;
    for (const tier of view.tiers) {
      if (heaviestDue !== null && tier.tier !== heaviestDue && view.dueTiers.includes(tier.tier)) {
        continue;
      }
      rows.push({ view, tier });
    }
  }
  rows.sort(
    (a, b) =>
      b.tier.usedFraction - a.tier.usedFraction ||
      a.view.registration.localeCompare(b.view.registration) ||
      a.tier.tier.localeCompare(b.tier.tier),
  );
  return rows.slice(0, limit);
}

/** `Booking it takes the aircraft out of service for 14 game days.` */
export function downtimeInWords(days: number): string {
  const rounded = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${rounded} game day${days === 1 ? '' : 's'}`;
}

/**
 * What not booking a tier means, stated before the choice rather than learned
 * after it.
 *
 * §7.3's chain — *"skipped maintenance → reliability decay → delays and
 * cancellations → reputation damage"* — and its end state, grounding. The model
 * has no deferral record: putting a check off is the absence of a booking. So
 * the page makes that absence a decision with its consequence written beside
 * the button, rather than something that happens by not clicking.
 */
export function deferralInWords(view: MaintenanceAirframeView, tier: MaintenanceTierView): string {
  const risk = `${(view.technicalRisk * 100).toFixed(1)}%`;
  if (tier.due) {
    return `Deferring it keeps the aircraft flying, but its technical-fault risk — ${risk} now — rises with every hour past due, and flown far enough past the limit it is grounded until the work is done.`;
  }
  return `Not due yet (${dueInWords(tier)}). Deferring costs nothing until it falls due; booking now takes the aircraft out of service early.`;
}
