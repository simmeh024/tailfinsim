import type { AdminAuditEntry, AdminGrantSummary, AdminWorldSummary } from '@tailfin/shared';

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

/** Field name to the reasons it was refused, as `ApiError.fields` carries them. */
export type FieldErrors = Record<string, string[]>;

export type CreateWorldResult =
  { ok: true; world: AdminWorldSummary } | { ok: false; fields: FieldErrors };

export async function fetchWorlds(): Promise<AdminWorldSummary[]> {
  const body = await getJson('/api/admin/worlds');
  if (typeof body !== 'object' || body === null) return [];
  const worlds = (body as { worlds?: unknown }).worlds;
  return Array.isArray(worlds) ? (worlds as AdminWorldSummary[]) : [];
}

/**
 * Creates a world, or returns the reasons it was refused.
 *
 * A refusal is **not an exception**. 400 and 409 here are the server answering
 * the question the form asked — "can this world exist?" — and the answer is the
 * point of submitting. Throwing would make the caller catch its own normal case.
 * Anything else, including a 403 or a dead server, still throws.
 */
export async function createWorld(config: unknown): Promise<CreateWorldResult> {
  const response = await fetch('/api/admin/worlds', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(config),
  });

  if (response.status === 201) {
    const body: unknown = await response.json();
    const world = (body as { world?: unknown }).world;
    return { ok: true, world: world as AdminWorldSummary };
  }

  if (response.status === 400 || response.status === 409) {
    const body: unknown = await response.json();
    const fields = (body as { fields?: unknown }).fields;
    const message = (body as { message?: unknown }).message;
    if (typeof fields === 'object' && fields !== null) {
      return { ok: false, fields: fields as FieldErrors };
    }
    // A refusal with no field detail still has to say something, or the form
    // silently does nothing and the admin concludes the button is broken.
    return {
      ok: false,
      fields: { form: [typeof message === 'string' ? message : 'The world was refused.'] },
    };
  }

  throw new Error(`POST /api/admin/worlds failed with ${String(response.status)}`);
}
