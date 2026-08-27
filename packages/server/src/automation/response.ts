import { DELEGATED_SHORTFALL } from '@tailfin/shared';

import type { ResolvedSetting } from './store';

/**
 * How an airline responds to a rolled flight delay (M5-05, ADR-0023 §2, §5).
 *
 * Pure, given the airline's setting, the delay it faces, and whether it holds
 * the Ops Controller seat — the one decision the automation ladder governs
 * first. The mechanical delay is already the world's (PR 1's roll); this decides
 * the **response**: let it run, or cancel to protect the rotation behind it — and
 * whether the situation is left for the player.
 *
 * The §3.1 boundary lives here as a fact about the return value: a decision is
 * completed offline (`taskKind === null`) **only** when a written policy rule
 * covered it. Manual, and Policy/Delegated with no covering rule, return a task
 * to raise — the situation waits for the player rather than being guessed.
 *
 * ## The delegated tier
 *
 * Delegated needs the Ops Controller hire; without it the airline drops to Policy
 * — the rules still run, but not _for_ it, and with no shortfall. With the hire,
 * the modelled {@link DELEGATED_SHORTFALL} applies: a delegated controller holds
 * a tighter cancellation margin than the player's own optimum, cancelling sooner
 * and giving up about ten per cent of the value ideal manual timing would keep.
 */
export interface DisruptionResponse {
  action: 'delay' | 'cancel';
  /** The task to raise for the player, or null when a policy rule cleanly covered it. */
  taskKind: 'disruption_review' | 'disruption_uncovered' | null;
}

export function resolveDisruptionResponse(
  setting: ResolvedSetting,
  delayMinutes: number,
  context: { hasController: boolean },
): DisruptionResponse {
  // Manual (and the default): the delay stands and the player is told, so they
  // can act on the rotation. Nothing is decided for them.
  if (setting.mode === 'manual') {
    return { action: 'delay', taskKind: 'disruption_review' };
  }

  // Delegated only runs "for you" with the Ops Controller seat filled; vacated,
  // it drops to Policy — rules still run, but with no shortfall (ADR-0023).
  const delegated = setting.mode === 'delegated' && context.hasController;

  const rule = setting.policy?.disruptionResponse;
  if (rule === undefined) {
    // In Policy or Delegated, but no rule covers a disruption response: out of
    // policy, so it waits rather than being guessed.
    return { action: 'delay', taskKind: 'disruption_uncovered' };
  }

  const ceiling = rule.cancelDelaysOverMinutes;
  if (ceiling === null) {
    // Accept every delay, however long — the honest "never cancel on my behalf".
    return { action: 'delay', taskKind: null };
  }

  // A delegated controller is a shade too eager to cut a delay — the modelled
  // shortfall tightens the ceiling, so it cancels sooner than the player's optimum.
  const effectiveCeiling = delegated ? ceiling * (1 - DELEGATED_SHORTFALL) : ceiling;
  if (delayMinutes > effectiveCeiling) {
    // The rule (or the delegate applying it) says a delay this long is not worth
    // flying. Cancel, and raise no task — this is exactly what was authorised.
    return { action: 'cancel', taskKind: null };
  }
  // Covered and accepted: the delay runs, no task.
  return { action: 'delay', taskKind: null };
}
