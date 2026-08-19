import type {
  AdminAuditEntry,
  AdminGrantSummary,
  AdminOverviewResponse,
  AdminPlayerDetail,
  AdminPlayerListResponse,
  AdminResetWorldResponse,
  AdminSpeedChangeResponse,
  AdminWorldHealthResponse,
  AdminWorldStatusResponse,
  AdminWorldSummary,
  WorldStatus,
} from '@tailfin/shared';

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

/**
 * The audit log.
 *
 * `includeViews` asks for the `player.viewed` rows the server leaves out by
 * default (M1A-08). Looking at somebody's account is recorded, but those entries
 * outnumber changes by orders of magnitude, and a log where "who reset the
 * world?" is buried under three hundred page views stops being read.
 */
export async function fetchAdminAudit(includeViews = false): Promise<AdminAuditEntry[]> {
  const body = await getJson(`/api/admin/audit${includeViews ? '?includeViews=true' : ''}`);
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

/**
 * A POST whose refusals are answers rather than exceptions.
 *
 * Every admin action asks a question the server is entitled to say no to — can
 * this world exist, can it run at that speed, can it be reset — and 400/404/409
 * are those answers. Throwing would make each caller catch its own normal case.
 * Anything else, including a 403 or a dead server, still throws: those are not
 * answers, they are failures.
 *
 * A refusal always carries *something* to show. A form that silently does
 * nothing is one an admin concludes is broken.
 */
async function postJson(
  path: string,
  payload: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; fields: FieldErrors }> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });

  if (response.ok) return { ok: true, body: await response.json() };

  if (response.status === 400 || response.status === 404 || response.status === 409) {
    const body: unknown = await response.json();
    const fields = (body as { fields?: unknown }).fields;
    const message = (body as { message?: unknown }).message;
    if (typeof fields === 'object' && fields !== null) {
      return { ok: false, fields: fields as FieldErrors };
    }
    return {
      ok: false,
      fields: { form: [typeof message === 'string' ? message : 'The request was refused.'] },
    };
  }

  throw new Error(`POST ${path} failed with ${String(response.status)}`);
}

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

export async function fetchOverview(): Promise<AdminOverviewResponse> {
  const body = await getJson('/api/admin/overview');
  return body as AdminOverviewResponse;
}

export type SpeedChangeResult =
  { ok: true; change: AdminSpeedChangeResponse } | { ok: false; fields: FieldErrors };

/**
 * Changes a world's speed (M1A-03).
 *
 * `expectedSpeedMultiplier` is the speed the console was showing when the admin
 * confirmed, and the server refuses a mismatch. That is deliberate rather than
 * defensive: the admin agreed to a specific sentence — "2.00× → 3.00×" — and if
 * somebody else has changed it since, carrying on would perform a change nobody
 * agreed to.
 *
 * Refusals are answers, not exceptions, for the same reason as `createWorld`:
 * "no, because…" is a normal outcome of asking. A 403 or a dead server still
 * throws.
 */
export async function changeWorldSpeed(
  worldId: string,
  speedMultiplier: number,
  expectedSpeedMultiplier: number,
): Promise<SpeedChangeResult> {
  const result = await postJson(`/api/admin/worlds/${encodeURIComponent(worldId)}/speed`, {
    speedMultiplier,
    expectedSpeedMultiplier,
  });
  return result.ok
    ? { ok: true, change: result.body as AdminSpeedChangeResponse }
    : { ok: false, fields: result.fields };
}

export type StatusChangeResult =
  { ok: true; change: AdminWorldStatusResponse } | { ok: false; fields: FieldErrors };

/**
 * Moves a world through its lifecycle (M1A-04).
 *
 * `expectedStatus` is what the console was showing. The server refuses a
 * mismatch rather than resolving it, because "lock this open world" is not the
 * same request as "lock this world, whatever state it is in".
 */
export async function changeWorldStatus(
  worldId: string,
  status: WorldStatus,
  expectedStatus: WorldStatus,
): Promise<StatusChangeResult> {
  const result = await postJson(`/api/admin/worlds/${encodeURIComponent(worldId)}/status`, {
    status,
    expectedStatus,
  });
  return result.ok
    ? { ok: true, change: result.body as AdminWorldStatusResponse }
    : { ok: false, fields: result.fields };
}

export type ResetWorldResult =
  { ok: true; reset: AdminResetWorldResponse } | { ok: false; fields: FieldErrors };

/**
 * Resets a world: rewinds its clock and destroys what the rewind invalidates.
 *
 * The name is typed by the admin and checked on the server against the world's
 * own row, so a confirmation read against one world cannot be applied to
 * another.
 */
export async function resetWorld(
  worldId: string,
  confirmName: string,
  reason: string,
  expectedStatus: WorldStatus,
): Promise<ResetWorldResult> {
  const result = await postJson(`/api/admin/worlds/${encodeURIComponent(worldId)}/reset`, {
    confirmName,
    reason,
    expectedStatus,
  });
  return result.ok
    ? { ok: true, reset: result.body as AdminResetWorldResponse }
    : { ok: false, fields: result.fields };
}

export async function fetchPlayers(query: string, offset = 0): Promise<AdminPlayerListResponse> {
  const params = new URLSearchParams();
  if (query !== '') params.set('q', query);
  if (offset > 0) params.set('offset', String(offset));
  const suffix = params.toString();
  const body = await getJson(`/api/admin/players${suffix === '' ? '' : `?${suffix}`}`);
  return body as AdminPlayerListResponse;
}

/**
 * One player, in full.
 *
 * This request is **recorded** — the server writes a `player.viewed` audit row
 * in the same transaction as the read, because opening somebody's account
 * discloses their identities, email address and sessions. Worth knowing when
 * calling it: there is no way to look without leaving a trace, deliberately.
 *
 * A 404 is an answer rather than a failure: the player is not there, or the id
 * is not an id.
 */
export async function fetchPlayer(playerId: string): Promise<AdminPlayerDetail | null> {
  const response = await fetch(`/api/admin/players/${encodeURIComponent(playerId)}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET player failed with ${String(response.status)}`);
  const body: unknown = await response.json();
  return (body as { player: AdminPlayerDetail }).player;
}

export async function fetchWorldHealth(): Promise<AdminWorldHealthResponse> {
  const body = await getJson('/api/admin/worlds/health');
  return body as AdminWorldHealthResponse;
}
