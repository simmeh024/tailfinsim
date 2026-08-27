import { and, eq } from 'drizzle-orm';

import {
  AutomationPolicy,
  type AutomationMode,
  type AutomationSetting,
  type AutomationSystem,
} from '@tailfin/shared';

import { automationSetting } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * The automation ladder's settings, read and written (M5-05, ADR-0023).
 *
 * Owner-scoped throughout: every read and write is keyed by the airline resolved
 * from the session, never a client-supplied id. Absence of a row is the default —
 * Manual with no policy — so a system a player never touched costs no storage and
 * a world reset that deletes the row restores the default.
 *
 * The `policy` column is JSON text parsed on the way out against today's schema
 * (`AutomationPolicy`). A malformed or unparseable policy is read as **no rule**,
 * never a guessed default: a policy the worker cannot read must not silently
 * start cancelling flights.
 */

export interface ResolvedSetting {
  mode: AutomationMode;
  policy: AutomationPolicy | null;
}

/** The default for a system with no row: Manual, no policy. */
export const DEFAULT_SETTING: ResolvedSetting = { mode: 'manual', policy: null };

function parsePolicy(raw: string | null): AutomationPolicy | null {
  if (raw === null) return null;
  try {
    const parsed = AutomationPolicy.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** One system's setting for the engine, defaulted when the airline has no row. */
export async function readSetting(
  db: Database,
  airlineId: string,
  system: AutomationSystem,
): Promise<ResolvedSetting> {
  const [row] = await db
    .select({ mode: automationSetting.mode, policy: automationSetting.policy })
    .from(automationSetting)
    .where(and(eq(automationSetting.airlineId, airlineId), eq(automationSetting.system, system)))
    .limit(1);
  if (!row) return DEFAULT_SETTING;
  return { mode: row.mode as AutomationMode, policy: parsePolicy(row.policy) };
}

/** Every setting this airline has stored, for the client. */
export async function listSettings(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<AutomationSetting[]> {
  const rows = await db
    .select({
      system: automationSetting.system,
      mode: automationSetting.mode,
      policy: automationSetting.policy,
    })
    .from(automationSetting)
    .where(eq(automationSetting.airlineId, own.id));
  return rows.map((row) => ({
    system: row.system as AutomationSystem,
    mode: row.mode as AutomationMode,
    policy: parsePolicy(row.policy),
  }));
}

/** Set the mode and policy for one system, replacing any prior setting. */
export async function writeSetting(
  db: Database,
  own: ResolvedPlayerAirline,
  system: AutomationSystem,
  next: { mode: AutomationMode; policy: AutomationPolicy | null },
): Promise<void> {
  const policyText = next.policy === null ? null : JSON.stringify(next.policy);
  await db
    .insert(automationSetting)
    .values({
      worldId: own.worldId,
      airlineId: own.id,
      system,
      mode: next.mode,
      policy: policyText,
    })
    .onConflictDoUpdate({
      target: [automationSetting.airlineId, automationSetting.system],
      set: { mode: next.mode, policy: policyText, updatedAt: new Date() },
    });
}
