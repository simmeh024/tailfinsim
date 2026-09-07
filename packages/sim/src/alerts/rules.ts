import type { AlertKind, AlertScreen, AlertSeverity, AlertSubjectType } from '@tailfin/shared';

/**
 * §14.5's alert rules (M8-13).
 *
 * Eight rules, one place, no database. The server reads state and this decides;
 * splitting it that way is what lets the whole rule set be tested against
 * arithmetic rather than against fixtures, and it is why the thresholds arrive
 * as an argument instead of being read here.
 *
 * ## Where the numbers live
 *
 * Not in this file, and not in `EconomyConfig` either. §14.5's *"7 days"*,
 * *"30 days"* and *"15%"* are not balance — they change when an alert is too
 * noisy or too quiet, not when the economy is retuned, and a retune is an
 * immutable versioned row that a world pins deliberately (§22.3). So they are
 * named server constants with their reasons written beside them, exactly like
 * M8-08's `CRITICAL_DAYS` and M8-11's `RIVAL_SHARE_THRESHOLD`, and this module
 * takes them as `AlertThresholds`.
 *
 * ## Why the sentences are here
 *
 * Because they are part of the decision. An alert whose text is assembled by the
 * client is an alert whose meaning two clients can disagree about, and the
 * numbers in the sentence are precisely the ones the rule fired on. The one
 * thing deliberately absent from every sentence is **money**: display currency
 * is the player's choice (M8-02) and conversion happens at the client's render
 * boundary, so a sentence with dollars baked into it would be the one string on
 * screen that ignored the setting. Every rule therefore says its piece in days,
 * counts and ratios.
 */

/** A rule's verdict, before the server gives it an id and a game-time instant. */
export interface RaisedAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  subjectType: AlertSubjectType;
  /** The link target — a route, airframe, base or contract id, or an ICAO. */
  subjectId: string;
  subjectLabel: string;
  /**
   * The deduplication identity: one open alert per `(airline, kind, subjectKey)`.
   *
   * Usually the same as `subjectId`, and separate because two rules need it
   * finer. A crew shortfall is per rank on a family, and the airline is the
   * only thing to link to; a rival entry is per rival, and the route is the only
   * thing to link to. Folding either into `subjectId` would either lose the link
   * or lose the distinction.
   */
  subjectKey: string;
  title: string;
  detail: string;
  screen: AlertScreen;
}

/** §14.5's thresholds, supplied by the caller. See the note above on why. */
export interface AlertThresholds {
  /** The trailing window a route's profitability is judged over, in game days. */
  routeLossWindowDays: number;
  /**
   * How many flown days the window must contain before a loss is a trend.
   *
   * A route that flew once and lost money is one bad Tuesday. Without this the
   * rule fires on a route opened yesterday, which is the loudest possible way to
   * tell a player nothing.
   */
  routeLossMinDays: number;
  /** §13.6's runway threshold. Below this, cash is the only question. */
  runwayCriticalDays: number;
  /** How far above §13.1's DSCR floor still counts as *approaching* it. */
  dscrHeadroom: number;
  /** How far ahead crew demand is projected, in game days. */
  crewShortfallDays: number;
  /** `usedFraction` at which a check stops being distant and starts being a plan. */
  checkDueWarnFraction: number;
  /** How near a contract's `term_end` must be to be worth saying, in game days. */
  contractExpiryDays: number;
  /** How recently a rival must have started flying to count as having *entered*. */
  competitorLookbackDays: number;
  /** §14.5's spill ceiling. Above it, the route is turning money away. */
  spillRateCeiling: number;
  /** Settled flights the spill rate needs before it means anything. */
  spillMinFlights: number;
  /** How near a lapse turns a warning critical, in game days. */
  contractExpiryCriticalDays: number;
}

/** One game day of a route's trading. Only days it actually flew appear. */
export interface RouteDayContribution {
  /** `YYYY-MM-DD` in game time. Present only when the route settled a flight. */
  day: string;
  /** Revenue less the flight's own cost, summed over the day. */
  contributionMinor: number;
}

export interface AlertRouteState {
  routeId: string;
  /** `EGLL–KJFK`, for the row the player reads. */
  label: string;
  /** Trailing `routeLossWindowDays` of trading, one entry per flown game day. */
  days: readonly RouteDayContribution[];
  /** Settled flights in the spill window. */
  flights: number;
  /** Passengers carried in the spill window. */
  carried: number;
  /** Passengers turned away in the spill window. */
  spilled: number;
  /**
   * Carriers whose first settled flight on this airport pair falls inside the
   * lookback — the ones that have just arrived, by name.
   */
  newRivals: readonly { airlineId: string; name: string }[];
}

/** One `(family, rank)` slot of crew supply against demand. */
export interface CrewProjection {
  family: string;
  rank: string;
  /** Heads the airline can actually roster today. */
  available: number;
  /** The legal complement its current fleet asks for. */
  requiredNow: number;
  /** The same, once every aeroplane due inside the horizon has arrived. */
  requiredAtHorizon: number;
}

/** One airframe's heaviest outstanding check. */
export interface CheckDue {
  airframeId: string;
  registration: string;
  /** `a`, `c` or `d`. */
  tier: string;
  /** `1` at the limit; above `1` overdue. */
  usedFraction: number;
  /** True when the airframe is already in a check — nothing to raise. */
  inCheck: boolean;
  /** True when the airframe may not legally fly. */
  grounded: boolean;
}

/** One handling contract's remaining term. */
export interface ContractTerm {
  contractId: string;
  airportIcao: string;
  /** The service line, already in words — `ramp and baggage`, not `ramp_baggage`. */
  serviceLine: string;
  /** Game days until `term_end`. Negative would mean the sweep is behind. */
  daysRemaining: number;
}

/** Everything the eight rules read about one airline. */
export interface AirlineAlertState {
  airlineId: string;
  airlineLabel: string;
  /** §13.6's projection. Null means *beyond the horizon*, never *zero days*. */
  runwayDays: number | null;
  /** Null when the airline owes nothing — §13.1's gate does not apply. */
  dscr: number | null;
  /** §13.1's floor for new borrowing, from the world's economy config. */
  dscrMinimum: number;
  routes: readonly AlertRouteState[];
  crew: readonly CrewProjection[];
  checks: readonly CheckDue[];
  contracts: readonly ContractTerm[];
}

/* ------------------------------------------------------------ the rules */

/**
 * §14.5: *route loss-making 7 days running*.
 *
 * A route that flies daily and a route that flies three times a week are both
 * *"loss-making for a week"* when every departure in the window lost money, and
 * only one of them has seven days of evidence. So the window is seven game days
 * and the test is **no profitable day in it** — not seven consecutive negative
 * days, which a thrice-weekly route can never produce and which would therefore
 * quietly exempt exactly the thin routes §14.4 exists to find.
 *
 * A break-even day counts as not-a-loss: zero contribution is not money leaving.
 */
export function routeLossAlert(
  route: AlertRouteState,
  thresholds: AlertThresholds,
): RaisedAlert | null {
  const flown = route.days.length;
  if (flown < thresholds.routeLossMinDays) return null;
  if (route.days.some((day) => day.contributionMinor >= 0)) return null;

  return {
    kind: 'route_loss_making',
    severity: 'critical',
    subjectType: 'route',
    subjectId: route.routeId,
    subjectLabel: route.label,
    subjectKey: route.routeId,
    title: `${route.label} is losing money`,
    detail:
      `Every one of the ${String(flown)} day(s) it flew in the last ` +
      `${String(thresholds.routeLossWindowDays)} lost money. The route diagnosis says ` +
      `whether that is price, cost, timing or a competitor.`,
    screen: 'network',
  };
}

/**
 * §14.5: *cash runway < 30 days*.
 *
 * `null` days means §13.6's projection reached its horizon without the balance
 * going negative, which is the *good* answer and must not be read as zero.
 */
export function cashRunwayAlert(
  state: AirlineAlertState,
  thresholds: AlertThresholds,
): RaisedAlert | null {
  const days = state.runwayDays;
  if (days === null || days >= thresholds.runwayCriticalDays) return null;

  return {
    kind: 'cash_runway',
    severity: 'critical',
    subjectType: 'airline',
    subjectId: state.airlineId,
    subjectLabel: state.airlineLabel,
    subjectKey: state.airlineId,
    title: `Cash runs out in ${String(days)} day(s)`,
    detail:
      `At the trailing operating rate, and with every bill already committed, the balance ` +
      `goes negative in ${String(days)} game day(s).`,
    screen: 'finance',
  };
}

/**
 * §14.5: *DSCR approaching covenant*.
 *
 * Two verdicts from one number, because they are two different situations. Below
 * the floor the airline **cannot borrow at all** — §13.1's gate is already shut
 * and that is a fact about today. Inside the headroom it still can, and the
 * alert is the only warning it will get before it cannot.
 *
 * An airline that owes nothing has no coverage ratio, and `dscr` is null rather
 * than infinite for that reason.
 */
export function dscrAlert(
  state: AirlineAlertState,
  thresholds: AlertThresholds,
): RaisedAlert | null {
  const dscr = state.dscr;
  if (dscr === null) return null;

  const ceiling = state.dscrMinimum * (1 + thresholds.dscrHeadroom);
  if (dscr >= ceiling) return null;

  const breached = dscr < state.dscrMinimum;
  return {
    kind: 'dscr_headroom',
    severity: breached ? 'critical' : 'warning',
    subjectType: 'airline',
    subjectId: state.airlineId,
    subjectLabel: state.airlineLabel,
    subjectKey: state.airlineId,
    title: breached ? 'Debt service coverage is below the floor' : 'Debt service coverage is thin',
    detail:
      `Coverage is ${dscr.toFixed(2)} against a floor of ${state.dscrMinimum.toFixed(2)}. ` +
      (breached
        ? 'No new borrowing is possible until trading covers the service.'
        : 'A worse month closes the door on new borrowing.'),
    screen: 'credit',
  };
}

/**
 * §14.5: *crew shortfall at base in 5 days*.
 *
 * **Not per base**, and that is a limit of the crew model rather than a choice
 * here: M5-01's demand is a complement per `(family, rank)` summed over the
 * whole fleet, so there is no per-base requirement to be short of. The alert
 * names the family and rank, which is what a player hires against, and
 * `docs/alerts-and-digest.md` records the localisation as absent.
 *
 * What makes it forecastable is the fleet: an aeroplane arriving in four days
 * raises the complement on the day it lands, and conversions take longer than
 * that. Already-short is critical; short-once-it-arrives is the warning that is
 * still worth acting on.
 */
export function crewShortfallAlerts(
  state: AirlineAlertState,
  thresholds: AlertThresholds,
): RaisedAlert[] {
  const out: RaisedAlert[] = [];

  for (const slot of state.crew) {
    const shortNow = slot.requiredNow - slot.available;
    const shortLater = slot.requiredAtHorizon - slot.available;

    // Covered both today and once the deliveries land: nothing to say.
    if (shortLater <= 0 && shortNow <= 0) continue;

    if (shortNow > 0) {
      out.push({
        kind: 'crew_shortfall',
        severity: 'critical',
        subjectType: 'airline',
        subjectId: state.airlineId,
        subjectLabel: `${slot.family} ${slot.rank}`,
        subjectKey: `crew:${slot.family}:${slot.rank}`,
        title: `${String(shortNow)} ${slot.family} ${slot.rank}(s) short`,
        detail:
          `The fleet asks for ${String(slot.requiredNow)} and ${String(slot.available)} can be ` +
          `rostered. Aeroplanes cannot launch without a legal complement.`,
        screen: 'crew',
      });
    } else {
      out.push({
        kind: 'crew_shortfall',
        severity: 'warning',
        subjectType: 'airline',
        subjectId: state.airlineId,
        subjectLabel: `${slot.family} ${slot.rank}`,
        subjectKey: `crew:${slot.family}:${slot.rank}`,
        title: `${slot.family} ${slot.rank}s run short in ${String(thresholds.crewShortfallDays)} day(s)`,
        detail:
          `Aeroplanes arriving inside ${String(thresholds.crewShortfallDays)} day(s) raise the ` +
          `requirement to ${String(slot.requiredAtHorizon)}, against ${String(slot.available)} ` +
          `rosterable. Hiring and conversion both take time.`,
        screen: 'crew',
      });
    }
  }

  return out;
}

/**
 * §14.5: *C-check due, no slot booked*.
 *
 * *"No slot booked"* is `status !== 'in_check'`. M4-06 has no booking calendar —
 * a check is booked and starts, so the only two states an airframe can be in are
 * *working* and *in a check*, and an aeroplane flying with a due check is
 * precisely the unbooked case the design doc means.
 *
 * Fires for whichever tier is heaviest and outstanding, not only the C: an
 * overdue A-check grounds an aeroplane exactly as firmly, and §7.3's consequence
 * chain starts at the first skipped check rather than at the second.
 */
export function checkDueAlert(check: CheckDue, thresholds: AlertThresholds): RaisedAlert | null {
  if (check.inCheck) return null;
  if (check.usedFraction < thresholds.checkDueWarnFraction) return null;

  const overdue = check.usedFraction >= 1;
  const tier = check.tier.toUpperCase();
  return {
    kind: 'check_due_unbooked',
    severity: overdue || check.grounded ? 'critical' : 'warning',
    subjectType: 'airframe',
    subjectId: check.airframeId,
    subjectLabel: check.registration,
    subjectKey: check.airframeId,
    title: check.grounded
      ? `${check.registration} is grounded for its ${tier}-check`
      : overdue
        ? `${check.registration} is overdue its ${tier}-check`
        : `${check.registration} is close to its ${tier}-check`,
    detail: overdue
      ? `The ${tier}-check is past its limit and no check is booked. Reliability decays ` +
        `and the dispatch gate will start refusing the aeroplane.`
      : `The ${tier}-check is at ${String(Math.round(check.usedFraction * 100))}% of its ` +
        `interval and no check is booked. Booking it now is a choice of when, not whether.`,
    screen: 'fleet',
  };
}

/**
 * §9.3's *"before it lapses"*, standing where §14.5 asks for a gate lease.
 *
 * Nothing in the game leases a gate — a `slot_holding` is a per-band operating
 * right with no term at all — so the expiring commitment a player actually has
 * is a handling contract, and §9.3 asks for this alert in its own words. The
 * sentence says *contract* rather than *lease* so it cannot be mistaken for the
 * thing that does not exist.
 */
export function contractExpiryAlert(
  contract: ContractTerm,
  thresholds: AlertThresholds,
): RaisedAlert | null {
  if (contract.daysRemaining > thresholds.contractExpiryDays) return null;

  const days = Math.max(0, Math.round(contract.daysRemaining));
  return {
    kind: 'ground_contract_expiring',
    severity: days <= thresholds.contractExpiryCriticalDays ? 'critical' : 'warning',
    subjectType: 'ground_contract',
    subjectId: contract.contractId,
    subjectLabel: `${contract.airportIcao} ${contract.serviceLine}`,
    subjectKey: contract.contractId,
    title: `${contract.serviceLine} at ${contract.airportIcao} lapses in ${String(days)} day(s)`,
    detail:
      `When the term ends the vendor slot is freed for a competitor and the station drops ` +
      `back to walk-up handling, which is dearer per turn.`,
    screen: 'ground',
  };
}

/**
 * §14.5: *competitor entered your route*.
 *
 * *"Entered"* is **started flying**, not opened a route row. A rival can hold an
 * open route it never operates, and that costs the player nothing; what moves a
 * load factor is an aeroplane in the market. So the server's test is the rival's
 * *first settled flight* on the airport pair falling inside the lookback, which
 * is measured on the world's clock and needs no remembered state — and which
 * stops being true on its own once the rival has older history, so the alert
 * resolves without anything having to expire it.
 *
 * One alert per rival rather than one per route: a second carrier arriving is a
 * second decision, and folding it into the first row would mean the player was
 * never told.
 */
export function competitorAlerts(
  route: AlertRouteState,
  thresholds: AlertThresholds,
): RaisedAlert[] {
  return route.newRivals.map((rival) => ({
    kind: 'competitor_entered_route' as const,
    severity: 'warning' as const,
    subjectType: 'route' as const,
    subjectId: route.routeId,
    subjectLabel: route.label,
    subjectKey: `${route.routeId}:${rival.airlineId}`,
    title: `${rival.name} entered ${route.label}`,
    detail:
      `Their first flight on the pair was inside the last ` +
      `${String(thresholds.competitorLookbackDays)} day(s). Expect your load factor to give ` +
      `ground before your fare does.`,
    screen: 'network',
  }));
}

/**
 * §14.5: *spill > 15% on a route* — *"you're turning away money"*.
 *
 * Spill is only recorded on a full aeroplane (App. A.5), so the rate is a
 * statement about capacity rather than about pricing: the demand was there and
 * the seats were not. A minimum flight count keeps one full Friday from reading
 * as a route-wide problem.
 */
export function spillAlert(
  route: AlertRouteState,
  thresholds: AlertThresholds,
): RaisedAlert | null {
  if (route.flights < thresholds.spillMinFlights) return null;
  const offered = route.carried + route.spilled;
  if (offered === 0) return null;

  const rate = route.spilled / offered;
  if (rate <= thresholds.spillRateCeiling) return null;

  return {
    kind: 'route_spill',
    severity: 'warning',
    subjectType: 'route',
    subjectId: route.routeId,
    subjectLabel: route.label,
    subjectKey: route.routeId,
    title: `${route.label} turned away ${String(route.spilled)} passenger(s)`,
    detail:
      `${String(Math.round(rate * 100))}% of the demand that wanted this route could not be ` +
      `carried across ${String(route.flights)} flight(s). A bigger aeroplane, another ` +
      `frequency or a higher fare all convert some of it.`,
    screen: 'network',
  };
}

/* --------------------------------------------------------------- the set */

/**
 * Every rule, over one airline's state.
 *
 * The order is the order §14.5 lists them in, which is roughly severity anyway.
 * Nothing here reads a clock or a database: given the same state and the same
 * thresholds this returns the same set, which is what the server's reconciliation
 * depends on — an alert that flickered would be raised and resolved on alternate
 * ticks and would defeat the deduplication entirely.
 */
export function evaluateAlerts(
  state: AirlineAlertState,
  thresholds: AlertThresholds,
): RaisedAlert[] {
  const out: RaisedAlert[] = [];

  for (const route of state.routes) {
    const loss = routeLossAlert(route, thresholds);
    if (loss) out.push(loss);
  }

  const runway = cashRunwayAlert(state, thresholds);
  if (runway) out.push(runway);

  const dscr = dscrAlert(state, thresholds);
  if (dscr) out.push(dscr);

  out.push(...crewShortfallAlerts(state, thresholds));

  for (const check of state.checks) {
    const due = checkDueAlert(check, thresholds);
    if (due) out.push(due);
  }

  for (const contract of state.contracts) {
    const expiry = contractExpiryAlert(contract, thresholds);
    if (expiry) out.push(expiry);
  }

  for (const route of state.routes) {
    out.push(...competitorAlerts(route, thresholds));
    const spill = spillAlert(route, thresholds);
    if (spill) out.push(spill);
  }

  return out;
}

/**
 * Split a freshly-evaluated set against what is already open.
 *
 * This is M8-13's second acceptance criterion in eleven lines: an alert whose
 * `(kind, subjectKey)` is already open is **left alone** — not re-raised, not
 * re-dated, not re-notified — and one that is open but no longer evaluates is
 * resolved. Running it twice with the same inputs raises nothing the second
 * time, which is what *"not repeated every tick"* has to mean when the sweep
 * runs every tick by design.
 *
 * Kept here rather than in the server because it is the other half of the rule
 * set: the decision *is this news?* belongs beside the decision *is this true?*.
 */
export function reconcileAlerts(
  evaluated: readonly RaisedAlert[],
  open: readonly { id: string; kind: AlertKind; subjectKey: string }[],
): { raise: RaisedAlert[]; resolve: string[]; unchanged: number } {
  // Joined on a separator no kind or subject key can contain, so
  // `('a', 'b c')` and `('a b', 'c')` cannot collide — the same reason
  // `hashSeed` joins its parts this way.
  const key = (kind: AlertKind, subjectKey: string) => `${kind}\u0000${subjectKey}`;

  const openByKey = new Map(open.map((row) => [key(row.kind, row.subjectKey), row.id]));
  const evaluatedKeys = new Set(evaluated.map((alert) => key(alert.kind, alert.subjectKey)));

  const raise: RaisedAlert[] = [];
  let unchanged = 0;
  for (const alert of evaluated) {
    if (openByKey.has(key(alert.kind, alert.subjectKey))) unchanged += 1;
    else raise.push(alert);
  }

  const resolve: string[] = [];
  for (const [openKey, id] of openByKey) {
    if (!evaluatedKeys.has(openKey)) resolve.push(id);
  }

  return { raise, resolve, unchanged };
}
