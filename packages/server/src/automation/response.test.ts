import { describe, expect, it } from 'vitest';

import { resolveDisruptionResponse } from './response';

import type { ResolvedSetting } from './store';

/**
 * The disruption-response decision (M5-05, ADR-0023 §2, §5).
 *
 * The §3.1 boundary made concrete: a decision completes offline (`taskKind`
 * null) only when a written rule covered it. Everything else leaves a task. And
 * the delegated tier's modelled shortfall — a delegate cancels sooner than the
 * player's own optimum.
 */
describe('resolving a disruption response', () => {
  const noController = { hasController: false };
  const withController = { hasController: true };

  const manual: ResolvedSetting = { mode: 'manual', policy: null };
  const policyCeiling = (minutes: number): ResolvedSetting => ({
    mode: 'policy',
    policy: { disruptionResponse: { cancelDelaysOverMinutes: minutes } },
  });
  const delegatedCeiling = (minutes: number): ResolvedSetting => ({
    mode: 'delegated',
    policy: { disruptionResponse: { cancelDelaysOverMinutes: minutes } },
  });

  it('under Manual, lets the delay run but leaves it for the player', () => {
    expect(resolveDisruptionResponse(manual, 240, noController)).toEqual({
      action: 'delay',
      taskKind: 'disruption_review',
    });
  });

  it('under Policy with no rule, waits for the player rather than guessing', () => {
    expect(resolveDisruptionResponse({ mode: 'policy', policy: {} }, 240, noController)).toEqual({
      action: 'delay',
      taskKind: 'disruption_uncovered',
    });
    expect(resolveDisruptionResponse({ mode: 'policy', policy: null }, 240, noController)).toEqual({
      action: 'delay',
      taskKind: 'disruption_uncovered',
    });
  });

  it('cancels a delay past the ceiling, and raises no task — it is what was asked', () => {
    expect(resolveDisruptionResponse(policyCeiling(120), 240, noController)).toEqual({
      action: 'cancel',
      taskKind: null,
    });
  });

  it('accepts a delay within the ceiling, cleanly and offline', () => {
    expect(resolveDisruptionResponse(policyCeiling(120), 60, noController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
    // Exactly at the ceiling is within it — the rule cancels only what is *over*.
    expect(resolveDisruptionResponse(policyCeiling(120), 120, noController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });

  it('never cancels when the ceiling is null — accept every delay', () => {
    const acceptAll: ResolvedSetting = {
      mode: 'policy',
      policy: { disruptionResponse: { cancelDelaysOverMinutes: null } },
    };
    expect(resolveDisruptionResponse(acceptAll, 100_000, withController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });

  it('a delegated controller cancels in the shortfall band a player would fly', () => {
    // Ceiling 120; the 10% shortfall tightens it to 108. A 115-minute delay is
    // within the player's own optimum but past the delegate's tighter margin.
    expect(resolveDisruptionResponse(delegatedCeiling(120), 115, withController)).toEqual({
      action: 'cancel',
      taskKind: null,
    });
    // Policy at the same ceiling would have flown it.
    expect(resolveDisruptionResponse(policyCeiling(120), 115, noController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
    // And below the tightened margin the delegate still accepts it.
    expect(resolveDisruptionResponse(delegatedCeiling(120), 100, withController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });

  it('delegated without the Ops Controller seat drops to Policy — no shortfall', () => {
    // Same delegated setting, but no controller: it behaves exactly as Policy,
    // so the 115-minute delay within the untightened 120 ceiling is accepted.
    expect(resolveDisruptionResponse(delegatedCeiling(120), 115, noController)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });
});
