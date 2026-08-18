import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/**
 * Admin console wire types (M1A-01, design doc §22).
 *
 * Everything in the M1A milestone changes a live world for every player in it,
 * so the vocabulary starts with the record of who did what rather than with the
 * actions themselves.
 */

/**
 * What an audited action did.
 *
 * A closed set rather than free text, because the audit log is something you
 * read under pressure — "which of these was the reset?" is not a question to be
 * answering by grepping prose. Each entry here is added by the milestone that
 * performs it, so the list grows with the console.
 */
export const AdminAction = z.enum([
  'admin.granted',
  'admin.revoked',
  'world.created',
  'world.opened',
  'world.reset',
  'world.speed_changed',
  'player.viewed',
]);
export type AdminAction = z.infer<typeof AdminAction>;

/** What an action was done *to*. */
export const AdminSubjectType = z.enum(['player', 'world', 'instance']);
export type AdminSubjectType = z.infer<typeof AdminSubjectType>;

/**
 * One line of the audit log.
 *
 * `actorLabel` is denormalised on purpose. §22.10 anonymises a departing player
 * rather than deleting them, but even so an audit entry has to stay legible
 * after the account behind it is gone — a log that reads "someone reset the
 * world" is not an audit log.
 */
export const AdminAuditEntry = z.object({
  id: Uuid,
  at: Timestamp,
  /** Null once the account has gone; `actorLabel` still says who it was. */
  actorPlayerId: Uuid.nullable(),
  actorLabel: z.string().min(1),
  action: AdminAction,
  subjectType: AdminSubjectType,
  subjectId: z.string().nullable(),
  /** State before and after, for the fields the action touched. Null where not applicable. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  /** Fastify's per-request id, so a log line and an audit row can be tied together. */
  requestId: z.string().nullable(),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntry>;

/** `GET /api/admin/audit`. Newest first. */
export const AdminAuditResponse = z.object({
  entries: z.array(AdminAuditEntry),
});
export type AdminAuditResponse = z.infer<typeof AdminAuditResponse>;

/** One person holding an admin grant. */
export const AdminGrantSummary = z.object({
  playerId: Uuid,
  displayName: z.string().min(1),
  grantedAt: Timestamp,
  /** Null for the first admin, who was granted from the command line before any admin existed. */
  grantedByPlayerId: Uuid.nullable(),
  grantedByLabel: z.string().nullable(),
});
export type AdminGrantSummary = z.infer<typeof AdminGrantSummary>;

/** `GET /api/admin/admins`. */
export const AdminListResponse = z.object({
  admins: z.array(AdminGrantSummary),
});
export type AdminListResponse = z.infer<typeof AdminListResponse>;

/**
 * A world as the console lists it (M1A-02).
 *
 * Carries the derived in-game date alongside the stored fields, because the
 * question an admin actually has about a world is what day it is in there — and
 * that is computed from `epoch`, `launchDate` and `speedMultiplier` rather than
 * stored (ADR-0005). Computing it on the server rather than in the browser keeps
 * §21's rule intact: a viewer with a skewed clock must not disagree about what
 * day it is.
 */
export const AdminWorldSummary = z.object({
  id: Uuid,
  name: z.string().min(1),
  epoch: Timestamp,
  launchDate: Timestamp,
  speedMultiplier: z.number().positive(),
  status: z.enum(['staging', 'open', 'locked', 'archived']),
  aircraftCatalogueVersion: z.string().min(1),
  economyConfigVersion: z.string().min(1),
  playerCap: z.number().int().positive().nullable(),
  createdAt: Timestamp,
  /** The world's current in-game date, derived on the server. */
  inGameDate: Timestamp,
});
export type AdminWorldSummary = z.infer<typeof AdminWorldSummary>;

/** `GET /api/admin/worlds`. */
export const AdminWorldListResponse = z.object({
  worlds: z.array(AdminWorldSummary),
});
export type AdminWorldListResponse = z.infer<typeof AdminWorldListResponse>;

/**
 * `POST /api/admin/worlds`.
 *
 * Deliberately has no `status` field. A world always starts in `staging`, and
 * opening one is a separate, deliberate act (M1A-04) — so there is no shape in
 * which the request can ask for an open world, rather than a rule saying it
 * must not.
 */
export const AdminCreateWorldResponse = z.object({
  world: AdminWorldSummary,
});
export type AdminCreateWorldResponse = z.infer<typeof AdminCreateWorldResponse>;
