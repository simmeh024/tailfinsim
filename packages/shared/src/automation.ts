import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/**
 * The automation ladder — Manual, Policy, Delegated (M5-05, ADR-0023, §9.5).
 *
 * The wire contract for the mode and the declarative policy a player holds per
 * system, and for the queue of situations the worker left for them (§3.1's
 * "waits for you"). The policy is **typed data**, never a stored expression: the
 * expressiveness a player needs is a short list of named levers, and a worker
 * that runs rules offline against a live airline must never run a script.
 */

/** The governed systems. `'disruption'` first; the set grows as systems land. */
export const AutomationSystem = z.enum(['disruption']);
export type AutomationSystem = z.infer<typeof AutomationSystem>;

/** How a system is run. Manual is the default and needs no stored row. */
export const AutomationMode = z.enum(['manual', 'policy', 'delegated']);
export type AutomationMode = z.infer<typeof AutomationMode>;

/**
 * How far short of ideal manual handling a *delegated* controller falls (ADR-0023 §5).
 *
 * A modelled, non-zero shortfall — never 0, so delegation is not free lunch;
 * never large, so it never punishes a player for having a life. 0.10 is §9.5's
 * _"beat it by 10% with attention"_. A balance number: it lives here until the
 * automation economy is tuned, then moves into the config like the office
 * salaries. Applied as a tighter effective cancellation margin — the delegated
 * controller is a shade too eager to cut a delay, and over-cancels about this
 * much of the value ideal manual timing would have kept.
 */
export const DELEGATED_SHORTFALL = 0.1;

/**
 * The disruption-response rule — the first typed lever (ADR-0023 §2).
 *
 * A delay ceiling: cancel a rolled delay longer than this many minutes to free
 * the aircraft and crew for the rotation behind it, at the price of the
 * passengers aboard. `null` accepts every delay, however long — the honest
 * "never cancel on my behalf".
 */
export const DisruptionResponsePolicy = z.object({
  cancelDelaysOverMinutes: z.number().int().positive().nullable(),
});
export type DisruptionResponsePolicy = z.infer<typeof DisruptionResponsePolicy>;

/**
 * The whole policy document. Every rule type is an optional field with its own
 * default meaning when absent, so an older policy stays parseable after a new
 * rule ships — the expand discipline the economy config and the database hold.
 */
export const AutomationPolicy = z.object({
  disruptionResponse: DisruptionResponsePolicy.optional(),
});
export type AutomationPolicy = z.infer<typeof AutomationPolicy>;

/** One system's setting, as the client sees it. */
export const AutomationSetting = z.object({
  system: AutomationSystem,
  mode: AutomationMode,
  /** The policy document, or null when none is written. */
  policy: AutomationPolicy.nullable(),
});
export type AutomationSetting = z.infer<typeof AutomationSetting>;

/** One situation the worker left for the player. */
export const OperationsTaskView = z.object({
  id: Uuid,
  system: z.string(),
  kind: z.string(),
  subjectId: Uuid.nullable(),
  detail: z.string(),
  raisedAt: Timestamp,
});
export type OperationsTaskView = z.infer<typeof OperationsTaskView>;

/** `GET /api/automation` — every setting, and the open operations queue. */
export const AutomationStateResponse = z.object({
  settings: z.array(AutomationSetting),
  tasks: z.array(OperationsTaskView),
});
export type AutomationStateResponse = z.infer<typeof AutomationStateResponse>;

/** `PUT /api/automation/:system` — set the mode and (optionally) the policy for a system. */
export const SetAutomationRequest = z.object({
  mode: AutomationMode,
  /** Replace the policy. Null clears it back to no rule. */
  policy: AutomationPolicy.nullable(),
});
export type SetAutomationRequest = z.infer<typeof SetAutomationRequest>;
