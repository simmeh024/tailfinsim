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
