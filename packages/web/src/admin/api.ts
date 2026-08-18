import type { AdminAuditEntry, AdminGrantSummary } from '@tailfin/shared';

/**
 * The admin console's half of the client API (M1A-01).
 *
 * Types are type-only imports, as everywhere else in the client, so the zod
 * schemas stay out of the bundle. The server serialises through the JSON Schema
 * derived from those same schemas, so a field that is not in the contract cannot
 * arrive here.
 *
 * A 403 is not an error condition to be retried — it is the correct answer for a
 * player without a grant. Callers surface it as "you cannot see this" rather than
 * "something went wrong".
 */

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${String(response.status)}`);
  }
  return response.json();
}

export async function fetchAdminAudit(): Promise<AdminAuditEntry[]> {
  const body = await getJson('/api/admin/audit');
  if (typeof body !== 'object' || body === null) return [];
  const entries = (body as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as AdminAuditEntry[]) : [];
}

export async function fetchAdmins(): Promise<AdminGrantSummary[]> {
  const body = await getJson('/api/admin/admins');
  if (typeof body !== 'object' || body === null) return [];
  const admins = (body as { admins?: unknown }).admins;
  return Array.isArray(admins) ? (admins as AdminGrantSummary[]) : [];
}
