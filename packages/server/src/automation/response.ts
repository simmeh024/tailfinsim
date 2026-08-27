import type { ResolvedSetting } from './store';

/**
 * How an airline responds to a rolled flight delay (M5-05, ADR-0023 §2).
 *
 * Pure, given the airline's setting and the delay it faces — the one decision the
 * automation ladder governs first. The mechanical delay is already the world's
 * (PR 1's roll); this decides the **response**: let it run, or cancel to protect
 * the rotation behind it — and whether the situation is left for the player.
 *
 * The §3.1 boundary lives here as a fact about the return value: a decision is
 * completed offline (`taskKind === null`) **only** when a written policy rule
 * covered it. Manual, and Policy/Delegated with no covering rule, return a task
 * to raise — the situation waits for the player rather than being guessed.
 *
 * Delegated behaves as Policy here; the office-hire gate and the modelled 10%
 * shortfall it adds are PR 4's, not this decision's.
 */
export interface DisruptionResponse {
  action: 'delay' | 'cancel';
  /** The task to raise for the player, or null when a policy rule cleanly covered it. */
  taskKind: 'disruption_review' | 'disruption_uncovered' | null;
}

export function resolveDisruptionResponse(
  setting: ResolvedSetting,
  delayMinutes: number,
): DisruptionResponse {
  // Manual (and the default): the delay stands and the player is told, so they
  // can act on the rotation. Nothing is decided for them.
  if (setting.mode === 'manual') {
    return { action: 'delay', taskKind: 'disruption_review' };
  }

  const rule = setting.policy?.disruptionResponse;
  if (rule === undefined) {
    // In Policy or Delegated, but no rule covers a disruption response: out of
    // policy, so it waits rather than being guessed.
    return { action: 'delay', taskKind: 'disruption_uncovered' };
  }

  const ceiling = rule.cancelDelaysOverMinutes;
  if (ceiling !== null && delayMinutes > ceiling) {
    // The player's own rule: a delay this long is not worth flying. Cancel, and
    // do not raise a task — this is exactly what they asked to happen.
    return { action: 'cancel', taskKind: null };
  }
  // Covered and accepted: the delay runs, no task.
  return { action: 'delay', taskKind: null };
}
