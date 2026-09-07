import { z } from 'zod';

import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * §14.5's alerts and §3.2's offline digest (M8-13).
 *
 * > Delivered in the offline digest and on the dashboard:
 * >
 * > `route loss-making 7 days running` · `cash runway < 30 days` · `DSCR
 * > approaching covenant` · `crew shortfall at base in 5 days` · `C-check due,
 * > no slot booked` · `gate lease expiring` · `competitor entered your route` ·
 * > `event announced affecting your network` · `spill > 15% on a route`
 *
 * Two of those nine have nothing to fire against, and they are named as absent
 * rather than approximated — see `AlertKind` below and
 * `docs/alerts-and-digest.md`.
 *
 * ## An alert is a stored row, not a computed list
 *
 * The tempting implementation is a function that recomputes the nine conditions
 * on every read. It cannot satisfy either of the criteria that matter. *"Alerts
 * are deduplicated, not repeated every tick"* needs to know whether this alert
 * has already been raised, which is a memory; and *"the digest covers the exact
 * period since last seen"* needs to know **when** each one was raised, which is
 * the same memory with a timestamp on it.
 *
 * So the worker raises rows and the reads project them. `raisedAt` and
 * `resolvedAt` are **game time** (ADR-0026), because everything an alert is
 * about — a loss-making week, a runway in days, a lapsing contract — is measured
 * on the world's clock, and a digest window that mixed the two calendars would
 * select a set that depended on which world speed the player left running.
 */

/**
 * The rules that fire.
 *
 * Seven of §14.5's nine, plus §9.3's own contract-lapse alert standing where the
 * design doc's *"gate lease expiring"* would be. What is deliberately missing:
 *
 * - **`gate lease expiring`** — nothing in the game leases a gate. `slot_holding`
 *   is a per-band operating right with no expiry at all (M7-05), so there is no
 *   term to count down. `ground_contract_expiring` is the real lapse in the
 *   game and §9.3 asks for exactly that alert, so it is here — labelled as a
 *   handling contract, never as a gate.
 * - **`event announced affecting your network`** — `world_event` is the flight
 *   transition queue (§21), not §18's announced world events. There is no
 *   announcement model, so there is nothing to be affected by. Inventing one
 *   here would put a fabricated headline in a feed whose whole value is that it
 *   describes what actually happened.
 */
export const AlertKind = z.enum([
  /** §14.5: route loss-making 7 days running. */
  'route_loss_making',
  /** §14.5: cash runway < 30 days. */
  'cash_runway',
  /** §14.5: DSCR approaching covenant. */
  'dscr_headroom',
  /** §14.5: crew shortfall at base in 5 days. */
  'crew_shortfall',
  /** §14.5: C-check due, no slot booked. */
  'check_due_unbooked',
  /** §9.3's *"before it lapses"*, standing where §14.5 asks for a gate lease. */
  'ground_contract_expiring',
  /** §14.5: competitor entered your route. */
  'competitor_entered_route',
  /** §14.5: spill > 15% on a route. */
  'route_spill',
]);
export type AlertKind = z.infer<typeof AlertKind>;

/**
 * How loudly to say it.
 *
 * `critical` is *money is leaving or an aeroplane cannot fly*; `warning` is
 * *this becomes critical if you do nothing*. There is no `info` — an alert
 * nobody has to act on is a statistic, and §14.3's dashboards are where a
 * statistic goes.
 */
export const AlertSeverity = z.enum(['critical', 'warning']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

/** What an alert is about. `airline` is the whole-airline case, not a missing subject. */
export const AlertSubjectType = z.enum([
  'airline',
  'route',
  'airframe',
  'crew_base',
  'ground_contract',
]);
export type AlertSubjectType = z.infer<typeof AlertSubjectType>;

/**
 * The screen an alert can be acted on (M8-13's third criterion).
 *
 * Named on the server and resolved to a path by the client, which is M8-10's
 * `drillHref` discipline: the server knows which subsystem owns the decision,
 * the client knows what its router calls that subsystem's page. A server that
 * emitted `/network?route=…` would be asserting a URL shape it cannot verify.
 *
 * Every member of this enum has a page that can answer. That is not a
 * convention — `alerts-ui.test.tsx` fails on a screen the router does not serve,
 * because M8-10 already learned that a drill-down to a page which cannot answer
 * is how a drill-down rots.
 */
export const AlertScreen = z.enum(['network', 'finance', 'credit', 'crew', 'fleet', 'ground']);
export type AlertScreen = z.infer<typeof AlertScreen>;

export const Alert = z
  .object({
    id: Uuid,
    kind: AlertKind,
    severity: AlertSeverity,
    subjectType: AlertSubjectType,
    /**
     * The subject's identifier — a uuid for a route, airframe, base or contract;
     * the airport's ICAO where the subject is a station; the airline's own id for
     * an airline-wide alert.
     *
     * Not `Uuid`, on purpose. A crew base is addressed by its airport and an
     * ICAO code is not a uuid, and a union that only *sometimes* held a uuid
     * would make every consumer guess which case it had.
     */
    subjectId: z.string().min(1),
    /** What to call the subject on screen — a route label, a registration, an ICAO. */
    subjectLabel: z.string().min(1),
    /** The headline. Short enough for a list row. */
    title: z.string().min(1),
    /** One sentence with the numbers in it. */
    detail: z.string().min(1),
    /** Where the player goes to do something about it. */
    screen: AlertScreen,
    /** Game-time instant the rule first fired. */
    raisedAt: Timestamp,
  })
  .strict();
export type Alert = z.infer<typeof Alert>;

/**
 * `GET /api/alerts` — every open alert for the player's airline.
 *
 * Ordered by the server: critical first, then oldest first inside a severity.
 * Oldest rather than newest deliberately — an alert that has been open for three
 * weeks is a decision the player keeps not taking, and burying it under this
 * morning's is how it stays untaken.
 */
export const AlertsResponse = z
  .object({
    alerts: z.array(Alert),
    /** Game-time instant the response was assembled. */
    gameNow: Timestamp,
    /**
     * Game-time instant the rules were last evaluated for this airline, or null
     * if they never have been.
     *
     * Present because an empty list has two meanings and a player deserves to
     * know which one they are looking at: *nothing is wrong*, or *nothing has
     * run*. On a node with no worker it is null for ever, and the page says so
     * rather than congratulating the airline.
     */
    evaluatedAt: Timestamp.nullable(),
  })
  .strict();
export type AlertsResponse = z.infer<typeof AlertsResponse>;

/* ------------------------------------------------------------------ digest */

/**
 * The period a digest covers.
 *
 * Both ends are game time. `days` is the game-day span, which is the unit §3.2's
 * feed is read in — *"you come back to a readable feed of what happened"*, and
 * what happened happened on the world's calendar.
 */
export const DigestWindow = z
  .object({
    fromAt: Timestamp,
    toAt: Timestamp,
    days: z.number().nonnegative(),
    /**
     * True when the absence was longer than the digest is allowed to cover.
     *
     * A player away for a game year would otherwise get a year of events in one
     * feed, which is not readable and is the one thing §3.2 asks for. The window
     * is capped and the flag says so, rather than the digest quietly pretending
     * the earlier part never happened.
     */
    truncated: z.boolean(),
    /** True the first time an airline ever asks — there is no *since* yet. */
    first: z.boolean(),
  })
  .strict();
export type DigestWindow = z.infer<typeof DigestWindow>;

/**
 * What the airline did while the player was away.
 *
 * Every figure comes from `flight_result` and `cash_movement` inside the window.
 * `flightsFlown` is zero on a node with no worker, and so is everything below
 * it — the digest says that in words rather than presenting a quiet week.
 */
export const DigestActivity = z
  .object({
    flightsFlown: z.number().int().nonnegative(),
    flightsCancelled: z.number().int().nonnegative(),
    passengers: z.number().int().nonnegative(),
    /** Share of settled flights inside 15 minutes. Null when nothing settled. */
    onTimeRate: z.number().min(0).max(1).nullable(),
    revenueMinor: MinorUnits.nonnegative(),
    costMinor: MinorUnits.nonnegative(),
    /** Every cash movement in the window, summed. Signed — a bad week is negative. */
    cashChangeMinor: z.number().int(),
  })
  .strict();
export type DigestActivity = z.infer<typeof DigestActivity>;

/**
 * `GET /api/digest` — §3.2's offline arrival digest.
 *
 * **A read that changes nothing.** Fetching the digest does not advance the
 * watermark, so a page refresh shows the same feed rather than an empty one, and
 * the endpoint stays a safe `GET` under ADR-0025. `POST /api/digest/read` is
 * what says *I have seen this*, and it carries the `toAt` it was shown so it can
 * never acknowledge past an event the player never saw.
 */
export const DigestResponse = z
  .object({
    window: DigestWindow,
    activity: DigestActivity,
    /** Alerts that fired inside the window — the *bad news since you left*. */
    raised: z.array(Alert),
    /**
     * Alerts that cleared inside the window.
     *
     * Good news is load-bearing in a feed of alerts: a digest that only ever
     * reported problems would show a player who fixed three routes the same
     * thing as a player who fixed none.
     */
    resolved: z.array(Alert),
    /** Open alerts right now, whenever they were raised. What still needs doing. */
    open: z.array(Alert),
  })
  .strict();
export type DigestResponse = z.infer<typeof DigestResponse>;

/**
 * `POST /api/digest/read` — acknowledge a digest.
 *
 * `throughAt` is the `window.toAt` the client was shown. The server only ever
 * moves the watermark **forward**, and never past its own current game time, so
 * a stale or forged value cannot skip a period the player has not seen.
 */
export const MarkDigestReadRequest = z
  .object({
    throughAt: Timestamp,
  })
  .strict();
export type MarkDigestReadRequest = z.infer<typeof MarkDigestReadRequest>;

export const MarkDigestReadResponse = z
  .object({
    /** Game-time instant the watermark now stands at. */
    coveredThroughAt: Timestamp,
  })
  .strict();
export type MarkDigestReadResponse = z.infer<typeof MarkDigestReadResponse>;
