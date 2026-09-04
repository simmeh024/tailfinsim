import { eq } from 'drizzle-orm';

import { nextExpansionTier } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { airline, officeExpansion } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import { readNeutralSeats } from './hires';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Headquarters expansion (M5-04, §9.1 "Expand Headquarters").
 *
 * Buying the next tier unlocks two more neutral office seats for a one-time
 * price, moving the airline from six offices toward the ten-office ceiling. The
 * charge is an AIR-06 `office_expansion` movement, so the money leaves the ledger
 * the one way money ever moves.
 *
 * Unlike a salary — a delayed bill that is allowed to push an airline negative —
 * this is a **discretionary purchase and refuses when the cash is not there**.
 * The whole thing is one transaction opened by a `FOR UPDATE` lock on the airline
 * row, so two clicks cannot both read the pre-purchase seat count and charge the
 * same tier twice; the second waits, sees the seats already unlocked, and is
 * offered the *next* tier or nothing.
 */

export type PurchaseExpansionResult =
  { ok: true; neutralSeats: number } | { ok: false; code: 'maxed' | 'insufficient_funds' };

export async function purchaseExpansion(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<PurchaseExpansionResult> {
  // Read the clock before taking the lock: expanding the headquarters happens
  // inside the world, so the charge carries the world's date (TIME-02).
  const gameNow = await worldGameNow(db, own.worldId);

  return db.transaction(async (tx) => {
    // Serialise concurrent purchases for this airline before reading its state.
    const [locked] = await tx
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1)
      .for('update');
    if (!locked) return { ok: false, code: 'insufficient_funds' };

    const current = await readNeutralSeats(tx, own.id);
    const tier = nextExpansionTier(current);
    if (tier === null) return { ok: false, code: 'maxed' };
    if (locked.cashMinor < tier.costMinor) return { ok: false, code: 'insufficient_funds' };

    const reference = `office_expansion:${own.id}:${String(tier.neutralSeats)}`;
    await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: -tier.costMinor,
      cause: 'office_expansion',
      reference,
      occurredAt: gameNow,
    });

    await tx
      .insert(officeExpansion)
      .values({ worldId: own.worldId, airlineId: own.id, neutralSeats: tier.neutralSeats })
      .onConflictDoUpdate({
        target: officeExpansion.airlineId,
        set: { neutralSeats: tier.neutralSeats, updatedAt: new Date() },
      });

    return { ok: true, neutralSeats: tier.neutralSeats };
  });
}
