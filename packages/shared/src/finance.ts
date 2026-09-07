import { z } from 'zod';

import { CabinClass, MinorUnits, Timestamp, Uuid } from './primitives';

/** The stable P&L vocabulary owned by M8-01. */
export const LedgerCategory = z.enum([
  'opening_balance',
  'equity',
  'ticket',
  'ancillary',
  'cargo',
  'charter',
  'acmi',
  'fuel',
  'lease_finance',
  'crew',
  'office_salary',
  'maintenance',
  'airport_slot',
  'atc',
  'ground_handling',
  'marketing',
  'repaint_retrofit',
  'interest',
  'aircraft_purchase',
  'asset_deposit',
  /**
   * Principal drawn on a loan (§13.3, M8-06).
   *
   * Neither revenue nor cost: the money arrives, and what it *costs* is the
   * interest that follows, which has its own `interest` category. Classifying a
   * draw as a cost would show a profitable airline a month of enormous losses
   * for having borrowed, and as revenue would show it a month of enormous
   * profit. `readProfitAndLoss` therefore counts it in neither total, and it is
   * the only category treated that way.
   */
  'debt_draw',
  /**
   * Buying a hub, or building a facility at one (App. B.5, M7-04).
   *
   * Capital, so it sits outside the operating P&L exactly as `aircraft_purchase`
   * does: a hub is an asset acquired, and charging $25M against one month would
   * bury the operation that month and flatter it for ever after. What a hub
   * *costs to run* is `hub_facility`, which is in the P&L.
   */
  'hub_purchase',
  /** App. B.5's recurring hub and facility fees — an operating cost, and in the P&L. */
  'hub_facility',
  'other',
]);
export type LedgerCategory = z.infer<typeof LedgerCategory>;

export const LedgerEntry = z.object({
  id: Uuid,
  cashMovementId: Uuid,
  amountMinor: MinorUnits,
  category: LedgerCategory,
  counterparty: z.string().min(1),
  flightId: Uuid.nullable(),
  routeId: Uuid.nullable(),
  aircraftId: Uuid.nullable(),
  hubId: Uuid.nullable(),
  cabinClass: CabinClass.nullable(),
  occurredAt: Timestamp,
  recordedAt: Timestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const PnlDimensionRow = z.object({
  key: z.string().nullable(),
  revenueMinor: MinorUnits.nonnegative(),
  costMinor: MinorUnits.nonnegative(),
  operatingProfitMinor: MinorUnits,
});
export type PnlDimensionRow = z.infer<typeof PnlDimensionRow>;

export const PnlLine = z.object({
  category: LedgerCategory,
  amountMinor: MinorUnits.nonnegative(),
  entryCount: z.number().int().nonnegative(),
});
export type PnlLine = z.infer<typeof PnlLine>;

/** A bounded, drillable operating statement for one game-time period. */
export const FinancePnlResponse = z.object({
  from: Timestamp,
  to: Timestamp,
  revenueMinor: MinorUnits.nonnegative(),
  costMinor: MinorUnits.nonnegative(),
  operatingProfitMinor: MinorUnits,
  lines: z.array(PnlLine),
  byRoute: z.array(PnlDimensionRow),
  byAircraft: z.array(PnlDimensionRow),
  byHub: z.array(PnlDimensionRow),
  byCabinClass: z.array(PnlDimensionRow),
});
export type FinancePnlResponse = z.infer<typeof FinancePnlResponse>;

/* ---- §13.6's cash runway (M8-08) -------------------------------------------- */

/** Which obligation a projected outflow is, so a UI can name the cause. */
export const CommitmentKind = z.enum(['crew', 'office', 'ground', 'hub', 'interest', 'arrears']);
export type CommitmentKind = z.infer<typeof CommitmentKind>;

/** One dated bill the airline has already committed to. */
export const CashCommitmentView = z
  .object({
    /** Game time, like every in-world instant (ADR-0026). */
    dueAt: Timestamp,
    amountMinor: MinorUnits.nonnegative(),
    kind: CommitmentKind,
    label: z.string(),
  })
  .strict();
export type CashCommitmentView = z.infer<typeof CashCommitmentView>;

/**
 * `GET /api/finance/runway` — §13.6's *"cash runway in in-game days"*.
 *
 * > A profitable airline can still run out of cash… The dashboard shows a cash
 * > runway **in in-game days** at all times, and it is the single most prominent
 * > number when it drops below 30.
 *
 * Everything the number is made of comes back with it, because §14.1 forbids a
 * figure a player cannot interrogate — and a runway is the figure they will most
 * want to argue with.
 */
export const CashRunwayResponse = z
  .object({
    /** The world clock the projection was taken against. */
    gameNow: Timestamp,
    cashMinor: MinorUnits,
    /**
     * Whole game days the airline can fund, or **null** for "beyond the horizon".
     *
     * Null rather than `horizonDays`: *"365 days"* and *"at least 365 days"* are
     * different claims, and a strip showing the first would be lying.
     */
    days: z.number().int().nonnegative().nullable(),
    horizonDays: z.number().int().positive(),
    /** Whether §13.6's threshold has been crossed. Decided here, never by the client. */
    critical: z.boolean(),
    criticalBelowDays: z.number().int().positive(),
    /** Net trading cash per game day. Negative is a burn. */
    dailyOperatingMinor: MinorUnits,
    rateWindowDays: z.number().int().positive(),
    /** Everything committed inside the horizon, whether or not it is listed below. */
    committedMinor: MinorUnits.nonnegative(),
    /** Of that, what is owed right now rather than on a future date. */
    owedNowMinor: MinorUnits.nonnegative(),
    /**
     * The bill that took the balance below zero, when one did.
     *
     * Null when the operating burn alone exhausted it — a distinction worth
     * drawing: one is a bill to plan around, the other is a business to fix.
     */
    tippedBy: CashCommitmentView.nullable(),
    /** The next few bills, soonest first. The cap is the server's; the total is above. */
    upcoming: z.array(CashCommitmentView),
  })
  .strict();
export type CashRunwayResponse = z.infer<typeof CashRunwayResponse>;
