import { z } from 'zod';

import { Airframe, AircraftSpec } from './aircraft';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/** The three acquisition paths in §7.2 (M4-04). */
export const AircraftAcquisitionKind = z.enum(['lease', 'used', 'new']);
export type AircraftAcquisitionKind = z.infer<typeof AircraftAcquisitionKind>;

export const AircraftOrderStatus = z.enum(['pending', 'delivered']);
export type AircraftOrderStatus = z.infer<typeof AircraftOrderStatus>;

const DeliveryAirportIcao = z.string().regex(/^[A-Z]{4}$/, 'must be a four-letter ICAO code');

/**
 * One idempotent acquisition request.
 *
 * `requestId` becomes the order id and the cash-movement reference. A browser
 * may therefore retry a timed-out request without buying the aircraft twice.
 */
export const AircraftAcquisitionInput = z.discriminatedUnion('kind', [
  z
    .object({
      requestId: Uuid,
      kind: z.literal('lease'),
      typeDesignation: z.string().min(1),
      deliveryAirportIcao: DeliveryAirportIcao,
    })
    .strict(),
  z
    .object({
      requestId: Uuid,
      kind: z.literal('used'),
      listingId: Uuid,
    })
    .strict(),
  z
    .object({
      requestId: Uuid,
      kind: z.literal('new'),
      typeDesignation: z.string().min(1),
      optionIds: z.array(z.string().min(1)).default([]),
      deliveryAirportIcao: DeliveryAirportIcao,
    })
    .strict(),
]);
export type AircraftAcquisitionInput = z.infer<typeof AircraftAcquisitionInput>;

/**
 * A non-mutating preview of the two type-level acquisition paths.
 *
 * Used aircraft are already individually priced physical listings, so their
 * preview is the listing itself. New and lease offers need this contract: it
 * lets the browser show the authoritative M4-03 fold, price and lead time
 * without importing simulation code or trying to reproduce the acquisition
 * engine.
 */
export const AircraftAcquisitionQuoteInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lease'),
      typeDesignation: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('new'),
      typeDesignation: z.string().min(1),
      optionIds: z.array(z.string().min(1)).default([]),
    })
    .strict(),
]);
export type AircraftAcquisitionQuoteInput = z.infer<typeof AircraftAcquisitionQuoteInput>;

/** The server-owned commercial/build preview rendered by the acquisition UI. */
export const AircraftAcquisitionQuoteResponse = z
  .object({
    kind: z.enum(['lease', 'new']),
    catalogueVersion: z.string().min(1),
    typeDesignation: z.string().min(1),
    buildOptionIds: z.array(z.string()),
    effectiveSpec: AircraftSpec,
    chargedMinor: MinorUnits.nonnegative(),
    monthlyLeaseRateMinor: MinorUnits.nonnegative().nullable(),
    /**
     * Weeks of the **world's** calendar, not of the wall clock (TIME-01).
     *
     * A client may render these as a span and may add them to
     * `quotedAt` — but only because both instants below are game time too. It
     * must not add them to its own `Date.now()`.
     */
    baseLeadTimeWeeks: z.number().int().nonnegative(),
    optionLeadTimeWeeks: z.number().int().nonnegative(),
    totalLeadTimeWeeks: z.number().int().nonnegative(),
    /** Informational only. The acquisition transaction reads and locks cash again. */
    cashMinor: MinorUnits,
    /** May be negative; the quote explains affordability but does not authorise it. */
    resultingCashMinor: MinorUnits,
    /** Game instants on the active world's clock, so the two are comparable. */
    quotedAt: Timestamp,
    estimatedDeliveryAt: Timestamp,
  })
  .strict();
export type AircraftAcquisitionQuoteResponse = z.infer<typeof AircraftAcquisitionQuoteResponse>;

/** The immutable commercial and build snapshot created when the order is accepted. */
export const AircraftOrder = z
  .object({
    id: Uuid,
    worldId: Uuid,
    airlineId: Uuid,
    kind: AircraftAcquisitionKind,
    status: AircraftOrderStatus,
    catalogueVersion: z.string().min(1),
    typeDesignation: z.string().min(1),
    buildOptionIds: z.array(z.string()),
    effectiveSpec: AircraftSpec,
    chargedMinor: MinorUnits.nonnegative(),
    monthlyLeaseRateMinor: MinorUnits.nonnegative().nullable(),
    baseLeadTimeWeeks: z.number().int().nonnegative(),
    optionLeadTimeWeeks: z.number().int().nonnegative(),
    deliveryAirportIcao: DeliveryAirportIcao,
    /**
     * Game instants on the owning world's clock (TIME-01).
     *
     * The dates a player is shown next to the world clock, so a client renders
     * them as world dates and never against the browser's own.
     */
    orderedAt: Timestamp,
    deliveryAt: Timestamp,
    deliveredAt: Timestamp.nullable(),
    airframeId: Uuid.nullable(),
  })
  .superRefine((order, context) => {
    const complete = order.deliveredAt !== null && order.airframeId !== null;
    if (order.status === 'delivered' && !complete) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'a delivered order must name its delivery time and airframe',
      });
    }
    if (order.status === 'pending' && (order.deliveredAt !== null || order.airframeId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'a pending order cannot have a delivery time or airframe',
      });
    }
  });
export type AircraftOrder = z.infer<typeof AircraftOrder>;

export const AircraftAcquisitionResponse = z.object({
  order: AircraftOrder,
  /** Present for immediate lease/used delivery and after a due new order materialises. */
  airframe: Airframe.nullable(),
  /** True when the same request id was safely replayed. */
  replayed: z.boolean(),
});
export type AircraftAcquisitionResponse = z.infer<typeof AircraftAcquisitionResponse>;

export const AircraftOrderListResponse = z.object({ orders: z.array(AircraftOrder) });
export type AircraftOrderListResponse = z.infer<typeof AircraftOrderListResponse>;
