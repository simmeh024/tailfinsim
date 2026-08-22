import { and, asc, desc, eq, lte } from 'drizzle-orm';

import {
  Airframe as AirframeSchema,
  AircraftOrder as AircraftOrderSchema,
  type AircraftAcquisitionInput,
  type AircraftAcquisitionResponse,
  type AircraftOrder,
  type Airframe,
} from '@tailfin/shared';
import {
  availabilityOf,
  computeEffectiveBuild,
  gameTime,
  resolveOptions,
  type BuildRefusal,
  type WorldClock,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { type Database } from '../db/client';
import {
  aircraftOrder,
  airframe,
  airline,
  airport,
  usedAircraftListing,
  world,
  type AircraftOrderRow,
  type AirframeRow,
  type CashMovementCause,
  type UsedAircraftListingRow,
} from '../db/schema';

import { loadCatalogueVersion } from './catalogue';

/** §7.2: a lease starts with two months paid as a deposit. */
export const LEASE_DEPOSIT_MONTHS = 2;
const REAL_WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export type AircraftAcquisitionRefusal =
  | { ok: false; kind: 'request-id-conflict' }
  | { ok: false; kind: 'airline-not-active'; status: 'restricted' | 'ceased' }
  | { ok: false; kind: 'type-not-found'; designation: string }
  | { ok: false; kind: 'type-not-orderable'; designation: string; availability: string }
  | { ok: false; kind: 'lease-not-offered'; designation: string }
  | { ok: false; kind: 'invalid-build'; refusals: readonly BuildRefusal[] }
  | { ok: false; kind: 'airport-not-found'; icao: string }
  | { ok: false; kind: 'listing-not-available'; listingId: string }
  | { ok: false; kind: 'insufficient-funds'; requiredMinor: number; availableMinor: number };

export type AircraftAcquisitionResult =
  ({ ok: true } & AircraftAcquisitionResponse) | AircraftAcquisitionRefusal;

function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

function jsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Expected a stored JSON array');
  return parsed;
}

function provisionalRegistration(orderId: string): string {
  // M4-04 needs a stable registration before M4-07 exposes fleet editing.
  // Ten characters, deterministic across retries, and unique by order UUID in
  // practice. A used aircraft keeps its actual registration instead.
  return `TF-${orderId.replaceAll('-', '').slice(0, 7).toUpperCase()}`;
}

function toAirframe(row: AirframeRow): Airframe {
  return AirframeSchema.parse({
    id: row.id,
    worldId: row.worldId,
    airlineId: row.airlineId,
    catalogueVersion: row.catalogueVersion,
    typeDesignation: row.typeDesignation,
    registration: row.registration,
    buildOptionIds: jsonArray(row.buildOptionIds),
    cabinConfigId: row.cabinConfigId,
    liveryId: row.liveryId,
    effectiveSpec: JSON.parse(row.effectiveSpec) as unknown,
    hours: row.hours,
    cycles: row.cycles,
    ownership: row.ownership,
    deliveredToIcao: row.deliveredToIcao,
    deliveredAt: row.deliveredAt.toISOString(),
    ownerHistory: jsonArray(row.ownerHistory),
  });
}

function toOrder(row: AircraftOrderRow, airframeId: string | null): AircraftOrder {
  return AircraftOrderSchema.parse({
    id: row.id,
    worldId: row.worldId,
    airlineId: row.airlineId,
    kind: row.kind,
    status: row.status,
    catalogueVersion: row.catalogueVersion,
    typeDesignation: row.typeDesignation,
    buildOptionIds: jsonArray(row.buildOptionIds),
    effectiveSpec: JSON.parse(row.effectiveSpec) as unknown,
    chargedMinor: row.chargedMinor,
    monthlyLeaseRateMinor: row.monthlyLeaseRateMinor,
    baseLeadTimeWeeks: row.baseLeadTimeWeeks,
    optionLeadTimeWeeks: row.optionLeadTimeWeeks,
    deliveryAirportIcao: row.deliveryAirportIcao,
    orderedAt: row.orderedAt.toISOString(),
    deliveryAt: row.deliveryAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    airframeId,
  });
}

async function responseForOrder(
  db: Database,
  row: AircraftOrderRow,
  replayed: boolean,
): Promise<AircraftAcquisitionResponse> {
  const frames = await db
    .select()
    .from(airframe)
    .where(eq(airframe.sourceOrderId, row.id))
    .limit(1);
  const frame = frames[0];
  return {
    order: toOrder(row, frame?.id ?? null),
    airframe: frame === undefined ? null : toAirframe(frame),
    replayed,
  };
}

function cashCause(kind: AircraftAcquisitionInput['kind']): CashMovementCause {
  switch (kind) {
    case 'lease':
      return 'aircraft_lease_deposit';
    case 'used':
      return 'aircraft_used_purchase';
    case 'new':
      return 'aircraft_new_purchase';
  }
}

class InsufficientFunds extends Error {
  constructor(
    readonly requiredMinor: number,
    readonly availableMinor: number,
  ) {
    super('The airline does not have enough cash for this aircraft acquisition');
  }
}

class ListingBecameUnavailable extends Error {
  constructor(readonly listingId: string) {
    super('The used-aircraft listing was claimed before this transaction completed');
  }
}

interface OrderFacts {
  catalogueVersion: string;
  typeDesignation: string;
  buildOptionIds: readonly string[];
  effectiveSpec: unknown;
  cabinConfigId: string | null;
  liveryId: string | null;
  ownerHistory: readonly unknown[];
  hours: number;
  cycles: number;
  /**
   * Inherited from a used listing; null for a lease or a new order, which are
   * built on delivery (M4-05).
   *
   * Travels with `hours` and `cycles` because it is the same kind of fact and
   * has the same acceptance criterion behind it: a used airframe *"arrives with
   * the previous owner's configuration intact"*, and one that was twelve years
   * old in the listing and brand new the moment it was bought would be the most
   * visible possible way to break that.
   */
  builtAt: Date | null;
  chargedMinor: number;
  monthlyLeaseRateMinor: number | null;
  baseLeadTimeWeeks: number;
  optionLeadTimeWeeks: number;
  deliveryAirportIcao: string;
  usedListingId: string | null;
}

function factsFromUsed(listing: UsedAircraftListingRow): OrderFacts {
  return {
    catalogueVersion: listing.catalogueVersion,
    typeDesignation: listing.typeDesignation,
    buildOptionIds: jsonArray(listing.buildOptionIds) as string[],
    effectiveSpec: JSON.parse(listing.effectiveSpec) as unknown,
    cabinConfigId: listing.cabinConfigId,
    liveryId: listing.liveryId,
    ownerHistory: jsonArray(listing.ownerHistory),
    hours: listing.hours,
    cycles: listing.cycles,
    builtAt: listing.builtAt,
    chargedMinor: listing.askingPriceMinor,
    monthlyLeaseRateMinor: null,
    baseLeadTimeWeeks: 0,
    optionLeadTimeWeeks: 0,
    deliveryAirportIcao: listing.locationIcao,
    usedListingId: listing.id,
  };
}

async function airportExists(db: Database, icao: string): Promise<boolean> {
  const rows = await db
    .select({ icao: airport.icaoCode })
    .from(airport)
    .where(eq(airport.icaoCode, icao))
    .limit(1);
  return rows.length > 0;
}

async function materializeAirframe(
  tx: Database,
  order: AircraftOrderRow,
  registration = provisionalRegistration(order.id),
): Promise<AirframeRow> {
  const existing = await tx
    .select()
    .from(airframe)
    .where(eq(airframe.sourceOrderId, order.id))
    .limit(1);
  if (existing[0]) return existing[0];

  const created = await tx
    .insert(airframe)
    .values({
      worldId: order.worldId,
      airlineId: order.airlineId,
      sourceOrderId: order.id,
      catalogueVersion: order.catalogueVersion,
      typeDesignation: order.typeDesignation,
      registration,
      buildOptionIds: order.buildOptionIds,
      cabinConfigId: order.cabinConfigId,
      liveryId: order.liveryId,
      effectiveSpec: order.effectiveSpec,
      ownerHistory: order.ownerHistory,
      hours: order.hours,
      cycles: order.cycles,
      builtAt: order.builtAt,
      ownership: order.kind === 'lease' ? 'leased' : 'owned',
      deliveredToIcao: order.deliveryAirportIcao,
      deliveredAt: order.deliveredAt ?? order.deliveryAt,
    })
    .onConflictDoNothing({ target: airframe.sourceOrderId })
    .returning();

  const frame = created[0];
  if (frame) return frame;
  const winner = await tx
    .select()
    .from(airframe)
    .where(eq(airframe.sourceOrderId, order.id))
    .limit(1);
  if (!winner[0]) throw new Error(`Airframe for order ${order.id} lost without a winner`);
  return winner[0];
}

/**
 * Lease, buy used, or order new in one atomic commercial transaction (M4-04).
 *
 * The order, used-listing claim and cash movement commit together. Immediate
 * paths also create the physical airframe in that transaction; new orders are
 * materialised later by {@link deliverDueAircraftOrders} in the Worker.
 */
export async function acquireAircraft(
  db: Database,
  own: ResolvedPlayerAirline,
  input: AircraftAcquisitionInput,
  realNow: Date = new Date(),
): Promise<AircraftAcquisitionResult> {
  try {
    return await db.transaction(async (tx): Promise<AircraftAcquisitionResult> => {
      const replay = await tx
        .select()
        .from(aircraftOrder)
        .where(eq(aircraftOrder.id, input.requestId))
        .limit(1)
        .for('update');
      if (replay[0]) {
        if (replay[0].airlineId !== own.id) return { ok: false, kind: 'request-id-conflict' };
        return { ok: true, ...(await responseForOrder(tx, replay[0], true)) };
      }

      const airlines = await tx
        .select({ status: airline.status, worldId: airline.worldId })
        .from(airline)
        .where(eq(airline.id, own.id))
        .limit(1)
        .for('update');
      const currentAirline = airlines[0];
      if (currentAirline?.worldId !== own.worldId) {
        return { ok: false, kind: 'request-id-conflict' };
      }
      if (currentAirline.status !== 'active') {
        return { ok: false, kind: 'airline-not-active', status: currentAirline.status };
      }

      const worlds = await tx
        .select({
          epoch: world.epoch,
          launchDate: world.launchDate,
          speedMultiplier: world.speedMultiplier,
          catalogueVersion: world.aircraftCatalogueVersion,
        })
        .from(world)
        .where(eq(world.id, own.worldId))
        .limit(1)
        .for('share');
      const selectedWorld = worlds[0];
      if (!selectedWorld) throw new Error(`No world ${own.worldId}`);
      const inGameNow = gameTime(clockOf(selectedWorld), realNow);

      let facts: OrderFacts;
      let usedRegistration: string | undefined;

      if (input.kind === 'used') {
        const listings = await tx
          .select()
          .from(usedAircraftListing)
          .where(
            and(
              eq(usedAircraftListing.id, input.listingId),
              eq(usedAircraftListing.worldId, own.worldId),
            ),
          )
          .limit(1)
          .for('update');
        const listing = listings[0];
        if (listing?.status !== 'available') {
          return { ok: false, kind: 'listing-not-available', listingId: input.listingId };
        }

        // Catalogue versions are immutable; read through the pool rather than
        // the transaction connection. `loadCatalogueVersion` intentionally
        // runs its three independent reads concurrently, which node-postgres
        // does not permit on one transaction client (and pg 9 will refuse).
        const catalogue = await loadCatalogueVersion(db, listing.catalogueVersion);
        const type = catalogue.types.get(listing.typeDesignation);
        if (!type) {
          return { ok: false, kind: 'type-not-found', designation: listing.typeDesignation };
        }
        const availability = availabilityOf(type.eraDates, inGameNow);
        if (
          availability === 'unannounced' ||
          availability === 'prototype' ||
          availability === 'retired'
        ) {
          return {
            ok: false,
            kind: 'type-not-orderable',
            designation: listing.typeDesignation,
            availability,
          };
        }
        facts = factsFromUsed(listing);
        usedRegistration = listing.registration;
      } else {
        const catalogue = await loadCatalogueVersion(db, selectedWorld.catalogueVersion);
        const type = catalogue.types.get(input.typeDesignation);
        if (!type) {
          return { ok: false, kind: 'type-not-found', designation: input.typeDesignation };
        }
        const availability = availabilityOf(type.eraDates, inGameNow);
        const permitted =
          input.kind === 'new'
            ? availability === 'orderable'
            : availability === 'orderable' || availability === 'used_only';
        if (!permitted) {
          return {
            ok: false,
            kind: 'type-not-orderable',
            designation: input.typeDesignation,
            availability,
          };
        }
        if (!(await airportExists(tx, input.deliveryAirportIcao))) {
          return { ok: false, kind: 'airport-not-found', icao: input.deliveryAirportIcao };
        }

        if (input.kind === 'lease') {
          if (type.monthlyLeaseRate === null) {
            return { ok: false, kind: 'lease-not-offered', designation: type.designation };
          }
          const build = computeEffectiveBuild({ baseSpec: type.baseSpec });
          facts = {
            catalogueVersion: catalogue.version,
            typeDesignation: type.designation,
            buildOptionIds: [],
            effectiveSpec: build.spec,
            cabinConfigId: null,
            liveryId: null,
            ownerHistory: [],
            hours: 0,
            cycles: 0,
            // A lease is an aircraft off the lessor's shelf, and the design says
            // nothing about its age. Null rather than "today" — an unknown build
            // date is a fact, and a fabricated one would make every leased
            // airframe eternally brand new. Lessor counterparties and lease terms
            // are §24 design debt.
            builtAt: null,
            chargedMinor: type.monthlyLeaseRate * LEASE_DEPOSIT_MONTHS,
            monthlyLeaseRateMinor: type.monthlyLeaseRate,
            baseLeadTimeWeeks: 0,
            optionLeadTimeWeeks: 0,
            deliveryAirportIcao: input.deliveryAirportIcao,
            usedListingId: null,
          };
        } else {
          if (type.listPrice === null) {
            return {
              ok: false,
              kind: 'type-not-orderable',
              designation: type.designation,
              availability,
            };
          }
          const resolved = resolveOptions({
            type,
            catalogue: catalogue.options,
            optionIds: input.optionIds,
          });
          if (!resolved.ok)
            return { ok: false, kind: 'invalid-build', refusals: resolved.refusals };
          const build = computeEffectiveBuild({
            baseSpec: type.baseSpec,
            options: resolved.options,
            listPriceMinor: type.listPrice,
          });
          facts = {
            catalogueVersion: catalogue.version,
            typeDesignation: type.designation,
            buildOptionIds: build.optionIds,
            effectiveSpec: build.spec,
            cabinConfigId: null,
            liveryId: null,
            ownerHistory: [],
            hours: 0,
            cycles: 0,
            // A factory order has no build date until it is built. The delivery
            // sweep is where that becomes known, and M4-05 does not reach into it.
            builtAt: null,
            chargedMinor: build.priceMinor,
            monthlyLeaseRateMinor: null,
            baseLeadTimeWeeks: type.baseDeliveryLeadWeeks,
            optionLeadTimeWeeks: build.leadTimeWeeks,
            deliveryAirportIcao: input.deliveryAirportIcao,
            usedListingId: null,
          };
        }
      }

      const immediate = input.kind !== 'new';
      const deliveryAt = new Date(
        realNow.getTime() + (facts.baseLeadTimeWeeks + facts.optionLeadTimeWeeks) * REAL_WEEK_MS,
      );
      const inserted = await tx
        .insert(aircraftOrder)
        .values({
          id: input.requestId,
          worldId: own.worldId,
          airlineId: own.id,
          kind: input.kind,
          status: immediate ? 'delivered' : 'pending',
          catalogueVersion: facts.catalogueVersion,
          typeDesignation: facts.typeDesignation,
          buildOptionIds: JSON.stringify(facts.buildOptionIds),
          cabinConfigId: facts.cabinConfigId,
          liveryId: facts.liveryId,
          effectiveSpec: JSON.stringify(facts.effectiveSpec),
          ownerHistory: JSON.stringify(facts.ownerHistory),
          hours: facts.hours,
          cycles: facts.cycles,
          builtAt: facts.builtAt,
          chargedMinor: facts.chargedMinor,
          monthlyLeaseRateMinor: facts.monthlyLeaseRateMinor,
          baseLeadTimeWeeks: facts.baseLeadTimeWeeks,
          optionLeadTimeWeeks: facts.optionLeadTimeWeeks,
          deliveryAirportIcao: facts.deliveryAirportIcao,
          usedListingId: facts.usedListingId,
          orderedAt: realNow,
          deliveryAt,
          deliveredAt: immediate ? realNow : null,
        })
        .returning();
      const order = inserted[0];
      if (!order) throw new Error('Aircraft order was not created');

      const movement = await moveAirlineCash(tx, {
        airlineId: own.id,
        amountMinor: -facts.chargedMinor,
        cause: cashCause(input.kind),
        reference: order.id,
        occurredAt: inGameNow,
      });
      if (movement.movement.balanceAfterMinor < 0) {
        throw new InsufficientFunds(
          facts.chargedMinor,
          movement.movement.balanceAfterMinor + facts.chargedMinor,
        );
      }

      if (input.kind === 'used') {
        const sold = await tx
          .update(usedAircraftListing)
          .set({ status: 'sold', soldAt: realNow })
          .where(
            and(
              eq(usedAircraftListing.id, input.listingId),
              eq(usedAircraftListing.status, 'available'),
            ),
          )
          .returning({ id: usedAircraftListing.id });
        if (!sold[0]) {
          // Throw, do not return: the order and cash movement already exist in
          // this transaction and must roll back with the failed claim.
          throw new ListingBecameUnavailable(input.listingId);
        }
      }

      if (immediate) await materializeAirframe(tx, order, usedRegistration);
      return { ok: true, ...(await responseForOrder(tx, order, false)) };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) {
      return {
        ok: false,
        kind: 'insufficient-funds',
        requiredMinor: error.requiredMinor,
        availableMinor: error.availableMinor,
      };
    }
    if (error instanceof ListingBecameUnavailable) {
      return { ok: false, kind: 'listing-not-available', listingId: error.listingId };
    }
    throw error;
  }
}

/** Orders newest-first for the authenticated airline; M4-07 can render this directly. */
export async function listAircraftOrders(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<readonly AircraftOrder[]> {
  const rows = await db
    .select({ order: aircraftOrder, airframeId: airframe.id })
    .from(aircraftOrder)
    .leftJoin(airframe, eq(airframe.sourceOrderId, aircraftOrder.id))
    .where(and(eq(aircraftOrder.airlineId, own.id), eq(aircraftOrder.worldId, own.worldId)))
    .orderBy(desc(aircraftOrder.orderedAt), desc(aircraftOrder.id));
  return rows.map((row) => toOrder(row.order, row.airframeId));
}

export interface DeliverySweepResult {
  delivered: number;
}

/**
 * Materialise due new orders against **real time**, owned only by the Worker.
 *
 * One transaction per order and `SKIP LOCKED`: two Workers during a rolling
 * handover may race, but `airframe.source_order_id` and the order row lock make
 * delivery exactly once. A batch cap prevents a long outage backlog from
 * turning one engine tick into a minute-long transaction.
 */
export async function deliverDueAircraftOrders(
  db: Database,
  worldId: string,
  realNow: Date = new Date(),
  batchSize = 100,
): Promise<DeliverySweepResult> {
  let delivered = 0;

  for (let handled = 0; handled < batchSize; handled += 1) {
    const done = await db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(aircraftOrder)
        .where(
          and(
            eq(aircraftOrder.worldId, worldId),
            eq(aircraftOrder.kind, 'new'),
            eq(aircraftOrder.status, 'pending'),
            lte(aircraftOrder.deliveryAt, realNow),
          ),
        )
        .orderBy(asc(aircraftOrder.deliveryAt), asc(aircraftOrder.id))
        .limit(1)
        .for('update', { skipLocked: true });
      const order = due[0];
      if (!order) return true;

      const updated = await tx
        .update(aircraftOrder)
        .set({ status: 'delivered', deliveredAt: realNow })
        .where(and(eq(aircraftOrder.id, order.id), eq(aircraftOrder.status, 'pending')))
        .returning();
      const deliveredOrder = updated[0];
      if (!deliveredOrder) return false;
      await materializeAirframe(tx, deliveredOrder);
      delivered += 1;
      return false;
    });
    if (done) break;
  }

  return { delivered };
}
