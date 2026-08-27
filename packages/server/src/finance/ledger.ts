import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { FinancePnlResponse, LedgerEntry } from '@tailfin/shared';
import type { FinancePnlResponse as FinancePnlResponseType } from '@tailfin/shared';

import { ledgerEntry } from '../db/schema';

import type { Database } from '../db/client';
import type { LedgerCategory, LedgerEntryRow } from '../db/schema';

/** Categories that belong in operating P&L; cash-only balance movements do not. */
export const PNL_CATEGORIES: readonly LedgerCategory[] = [
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
];

export interface LedgerQuery {
  airlineId: string;
  from: Date;
  to: Date;
  routeId?: string;
  aircraftId?: string;
  hubId?: string;
  cabinClass?: 'economy' | 'premium_economy' | 'business' | 'first';
}

function conditions(query: LedgerQuery) {
  return and(
    eq(ledgerEntry.airlineId, query.airlineId),
    gte(ledgerEntry.occurredAt, query.from),
    lte(ledgerEntry.occurredAt, query.to),
    inArray(ledgerEntry.category, PNL_CATEGORIES),
    query.routeId ? eq(ledgerEntry.routeId, query.routeId) : undefined,
    query.aircraftId ? eq(ledgerEntry.aircraftId, query.aircraftId) : undefined,
    query.hubId ? eq(ledgerEntry.hubId, query.hubId) : undefined,
    query.cabinClass ? eq(ledgerEntry.cabinClass, query.cabinClass) : undefined,
  );
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${label} is outside safe integer range`);
  return parsed;
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Finance period contains an invalid date');
  return date.toISOString();
}

function wireEntry(row: LedgerEntryRow) {
  return LedgerEntry.parse({
    id: row.id,
    cashMovementId: row.cashMovementId,
    amountMinor: row.amountMinor,
    category: row.category,
    counterparty: row.counterparty,
    flightId: row.flightId,
    routeId: row.routeId,
    aircraftId: row.aircraftId,
    hubId: row.hubId,
    cabinClass: row.cabinClass,
    occurredAt: iso(row.occurredAt),
    recordedAt: iso(row.recordedAt),
  });
}

/** Return immutable ledger rows for a drill-down, bounded for safe API use. */
export async function listLedgerEntries(
  db: Database,
  query: LedgerQuery,
  limit = 200,
): Promise<ReturnType<typeof wireEntry>[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Ledger page size must be between 1 and 1,000');
  }
  const rows = await db
    .select()
    .from(ledgerEntry)
    .where(conditions(query))
    .orderBy(asc(ledgerEntry.occurredAt), asc(ledgerEntry.id))
    .limit(limit);
  return rows.map(wireEntry);
}

interface AggregateRow {
  key: string | null;
  revenue: string;
  cost: string;
}

function aggregate(row: AggregateRow) {
  const revenueMinor = safeInteger(row.revenue, 'P&L revenue');
  const costMinor = safeInteger(row.cost, 'P&L cost');
  return {
    key: row.key,
    revenueMinor,
    costMinor,
    operatingProfitMinor: revenueMinor - costMinor,
  };
}

async function grouped(
  db: Database,
  query: LedgerQuery,
  dimension: 'route' | 'aircraft' | 'hub' | 'cabinClass',
) {
  const column =
    dimension === 'route'
      ? ledgerEntry.routeId
      : dimension === 'aircraft'
        ? ledgerEntry.aircraftId
        : dimension === 'hub'
          ? ledgerEntry.hubId
          : ledgerEntry.cabinClass;

  const rows = await db
    .select({
      key: column,
      revenue: sql<string>`coalesce(sum(case when ${ledgerEntry.amountMinor} > 0 then ${ledgerEntry.amountMinor} else 0 end), 0)::text`,
      cost: sql<string>`coalesce(sum(case when ${ledgerEntry.amountMinor} < 0 then -${ledgerEntry.amountMinor} else 0 end), 0)::text`,
    })
    .from(ledgerEntry)
    .where(conditions(query))
    .groupBy(column)
    .orderBy(sql`sum(abs(${ledgerEntry.amountMinor})) desc`);
  return rows.map(aggregate);
}

/**
 * Read an itemised operating statement and its four dimensional drill-downs.
 * All aggregation is performed by PostgreSQL against the indexed ledger; the
 * API never loads an airline's full history into application memory.
 */
export async function readProfitAndLoss(
  db: Database,
  query: LedgerQuery,
): Promise<FinancePnlResponseType> {
  if (query.to < query.from) throw new RangeError('Finance period ends before it starts');

  const [lines, byRoute, byAircraft, byHub, byCabinClass] = await Promise.all([
    db
      .select({
        category: ledgerEntry.category,
        amount: sql<string>`coalesce(sum(abs(${ledgerEntry.amountMinor})), 0)::text`,
        entryCount: sql<string>`count(*)::text`,
      })
      .from(ledgerEntry)
      .where(conditions(query))
      .groupBy(ledgerEntry.category)
      .orderBy(asc(ledgerEntry.category)),
    grouped(db, query, 'route'),
    grouped(db, query, 'aircraft'),
    grouped(db, query, 'hub'),
    grouped(db, query, 'cabinClass'),
  ]);

  let revenueMinor = 0;
  let costMinor = 0;
  const pnlLines = lines.map((line) => {
    const amountMinor = safeInteger(line.amount, `P&L ${line.category}`);
    if (['ticket', 'ancillary', 'cargo', 'charter', 'acmi'].includes(line.category)) {
      revenueMinor += amountMinor;
    } else {
      costMinor += amountMinor;
    }
    return {
      category: line.category,
      amountMinor,
      entryCount: safeInteger(line.entryCount, 'P&L entry count'),
    };
  });

  return FinancePnlResponse.parse({
    from: iso(query.from),
    to: iso(query.to),
    revenueMinor,
    costMinor,
    operatingProfitMinor: revenueMinor - costMinor,
    lines: pnlLines,
    byRoute,
    byAircraft,
    byHub,
    byCabinClass,
  });
}
