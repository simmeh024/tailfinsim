import { describe, expect, it } from 'vitest';

import { resolveDisruptionResponse } from './response';

import type { ResolvedSetting } from './store';

/**
 * The disruption-response decision (M5-05, ADR-0023 §2).
 *
 * The §3.1 boundary made concrete: a decision completes offline (`taskKind`
 * null) only when a written rule covered it. Everything else leaves a task.
 */
describe('resolving a disruption response', () => {
  const manual: ResolvedSetting = { mode: 'manual', policy: null };
  const policyWithCeiling = (minutes: number): ResolvedSetting => ({
    mode: 'policy',
    policy: { disruptionResponse: { cancelDelaysOverMinutes: minutes } },
  });

  it('under Manual, lets the delay run but leaves it for the player', () => {
    expect(resolveDisruptionResponse(manual, 240)).toEqual({
      action: 'delay',
      taskKind: 'disruption_review',
    });
  });

  it('under Policy with no rule, waits for the player rather than guessing', () => {
    expect(resolveDisruptionResponse({ mode: 'policy', policy: {} }, 240)).toEqual({
      action: 'delay',
      taskKind: 'disruption_uncovered',
    });
    // A policy with no policy document at all is the same case.
    expect(resolveDisruptionResponse({ mode: 'policy', policy: null }, 240)).toEqual({
      action: 'delay',
      taskKind: 'disruption_uncovered',
    });
  });

  it('cancels a delay past the ceiling, and raises no task — it is what was asked', () => {
    expect(resolveDisruptionResponse(policyWithCeiling(120), 240)).toEqual({
      action: 'cancel',
      taskKind: null,
    });
  });

  it('accepts a delay within the ceiling, cleanly and offline', () => {
    expect(resolveDisruptionResponse(policyWithCeiling(120), 60)).toEqual({
      action: 'delay',
      taskKind: null,
    });
    // Exactly at the ceiling is within it — the rule cancels only what is *over*.
    expect(resolveDisruptionResponse(policyWithCeiling(120), 120)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });

  it('never cancels when the ceiling is null — accept every delay', () => {
    const acceptAll: ResolvedSetting = {
      mode: 'policy',
      policy: { disruptionResponse: { cancelDelaysOverMinutes: null } },
    };
    expect(resolveDisruptionResponse(acceptAll, 100_000)).toEqual({
      action: 'delay',
      taskKind: null,
    });
  });

  it('treats Delegated as Policy for the decision itself', () => {
    const delegated: ResolvedSetting = {
      mode: 'delegated',
      policy: { disruptionResponse: { cancelDelaysOverMinutes: 90 } },
    };
    expect(resolveDisruptionResponse(delegated, 200)).toEqual({ action: 'cancel', taskKind: null });
  });
});
