import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';
import { WorldStatus } from './world';
import { MAX_SPEED_MULTIPLIER } from './world-config';

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
  'world.locked',
  'world.unlocked',
  'world.archived',
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
  status: WorldStatus,
  aircraftCatalogueVersion: z.string().min(1),
  economyConfigVersion: z.string().min(1),
  playerCap: z.number().int().positive().nullable(),
  createdAt: Timestamp,
  /** The world's current in-game date, derived on the server. */
  inGameDate: Timestamp,
  /**
   * Events still waiting in this world's queue (M1A-03).
   *
   * Here because a speed change has to be able to say what it does to them, and
   * "some" is not an answer an admin can weigh. M1A-06 turns this into queue
   * health proper — depth over time, oldest pending, whether the loop is keeping
   * up — where a bare count becomes a trend.
   */
  pendingEvents: z.number().int().nonnegative(),
  /**
   * Airlines in this world (M1A-04).
   *
   * The number a reset destroys. A confirmation that says "this will delete the
   * airlines" is asking for agreement to an unknown quantity; one that says
   * "this will delete 14 airlines" is asking a question that can be answered.
   */
  airlines: z.number().int().nonnegative(),
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

/**
 * `POST /api/admin/worlds/:worldId/speed` (M1A-03, §22.2).
 *
 * ## Why the request states what it thinks the speed is now
 *
 * The console shows a confirmation naming the current speed and the new one —
 * "2.00× → 3.00×" — and the admin agrees to *that* sentence. If someone else
 * changed the speed while it was on screen, the sentence is no longer true, and
 * applying it anyway would perform a change nobody agreed to. So the request
 * carries the speed it believed, and the server refuses a mismatch rather than
 * resolving it.
 *
 * This is the cheap half of §22.2's two-person rule. The full rule — one admin
 * requests, another approves — needs a request/approve flow that does not exist
 * yet, and cannot be exercised at all while there is one administrator. This
 * stops two admins from silently overwriting each other; it does not stop one
 * admin acting alone.
 */
export const AdminSpeedChangeRequest = z.object({
  speedMultiplier: z.number().positive().max(MAX_SPEED_MULTIPLIER),
  /** The speed the console was showing when the admin confirmed. */
  expectedSpeedMultiplier: z.number().positive(),
});
export type AdminSpeedChangeRequest = z.infer<typeof AdminSpeedChangeRequest>;

/** The world's clock, on one side of a change. */
export const AdminClockSnapshot = z.object({
  speedMultiplier: z.number().positive(),
  launchDate: Timestamp,
  /** The in-game date at the instant of the change, as measured on that side of it. */
  inGameDate: Timestamp,
});
export type AdminClockSnapshot = z.infer<typeof AdminClockSnapshot>;

/**
 * What a speed change did.
 *
 * `before` and `after` are the evidence for the criterion that matters: the
 * in-game date is the same on both sides, and `launchDate` moved instead. They
 * are the same pair written to the audit log.
 */
export const AdminSpeedChangeResponse = z.object({
  world: AdminWorldSummary,
  before: AdminClockSnapshot,
  after: AdminClockSnapshot,
  /**
   * Pending events at the moment of the change. Every one keeps its in-game
   * moment untouched — `world_event.fire_at` is stored in game time (M1-06), so
   * there is nothing to reschedule. What changes is the real-world wait.
   */
  pendingEvents: z.number().int().nonnegative(),
  /**
   * How far the calendar actually moved, in milliseconds. Zero or negative, never
   * positive: `launchDate` is whole milliseconds, so a speed that does not divide
   * the elapsed game time leaves a residue, and the sim rounds it in the
   * direction that cannot make a scheduled event fire early.
   *
   * Reported rather than hidden. "The in-game date does not change" is a claim,
   * and this is the measurement behind it.
   */
  driftMs: z.number().int().nonpositive(),
});
export type AdminSpeedChangeResponse = z.infer<typeof AdminSpeedChangeResponse>;

/**
 * `POST /api/admin/worlds/:worldId/status` (M1A-04, §22.2).
 *
 * `expectedStatus` for the same reason the speed change carries the speed it
 * believed: the console showed a world in a particular state and the admin acted
 * on that. If it has moved since, the action they chose is not the action that
 * would happen.
 *
 * Not every status is reachable from every other — see `WORLD_TRANSITIONS`. The
 * request shape does not encode that, because the legal set depends on where the
 * world is now and the server is what knows.
 */
export const AdminWorldStatusRequest = z.object({
  status: WorldStatus,
  expectedStatus: WorldStatus,
});
export type AdminWorldStatusRequest = z.infer<typeof AdminWorldStatusRequest>;

/**
 * Which statuses a world can move to from where it is (§22.2).
 *
 * Shared rather than server-only so the console can offer exactly the buttons
 * that will work, instead of offering everything and explaining refusals. The
 * server checks it again — this is what the interface renders, not what it is
 * allowed to do.
 *
 * The two absences are the decisions:
 *
 *   - **`open` cannot go straight to `archived`.** Archiving is permanent and
 *     read-only, and doing it to a world with players in flight should take two
 *     deliberate acts rather than one. Lock it, then archive it.
 *   - **`archived` goes nowhere.** §22.2 keeps archived worlds browsable for
 *     ever; un-archiving would let a record start moving again, and a record
 *     that can change is not one.
 */
export const WORLD_TRANSITIONS: Readonly<Record<WorldStatus, readonly WorldStatus[]>> = {
  staging: ['open', 'archived'],
  open: ['locked'],
  locked: ['open', 'archived'],
  archived: [],
};

export const AdminWorldStatusResponse = z.object({
  world: AdminWorldSummary,
  before: WorldStatus,
  after: WorldStatus,
});
export type AdminWorldStatusResponse = z.infer<typeof AdminWorldStatusResponse>;

/**
 * `POST /api/admin/worlds/:worldId/reset` (M1A-04, ADR-0005).
 *
 * The most destructive control in the product, and the request shape is where
 * that is made real:
 *
 *   - **`confirmName`** must be the world's name, typed. Not a checkbox — a
 *     checkbox is one click from a mis-click, and the name is the one thing that
 *     cannot be supplied by muscle memory on the wrong row.
 *   - **`reason`** is mandatory and goes into the audit log. ADR-0005 asks for
 *     it, and the entry that matters is the one read months later by somebody
 *     asking why a world went back to zero.
 *   - **`expectedStatus`** so a world that was opened to players while the
 *     confirmation sat on screen is refused rather than quietly reset.
 */
export const AdminResetWorldRequest = z.object({
  confirmName: z.string().min(1),
  reason: z.string().trim().min(4),
  expectedStatus: WorldStatus,
});
export type AdminResetWorldRequest = z.infer<typeof AdminResetWorldRequest>;

/** What a reset destroyed, counted as it happened. */
export const AdminResetWorldResponse = z.object({
  world: AdminWorldSummary,
  destroyed: z.object({
    airlines: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
  /**
   * The in-game date immediately after the reset. Equals the world's epoch, and
   * the server refuses to commit a reset where it does not — the criterion is
   * checked against the stored row rather than assumed from the arithmetic.
   */
  inGameDate: Timestamp,
  reason: z.string(),
});
export type AdminResetWorldResponse = z.infer<typeof AdminResetWorldResponse>;

/**
 * One thing that wants attention (M1A-07).
 *
 * Computed on the **server**, not the client. Whether a backup is overdue is a
 * judgement about the state of the system, and §21's rule is that the server
 * owns those — a browser deciding for itself when to worry would drift from what
 * the box actually knows.
 */
export const AdminAlert = z.object({
  /** Stable code, so an alert can be recognised without matching on prose. */
  code: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  /** One line, in words. */
  message: z.string().min(1),
  /** The specifics behind it, where there are any. */
  detail: z.string().nullable(),
});
export type AdminAlert = z.infer<typeof AdminAlert>;

/** The last backup run, as the box recorded it. Null when nothing has been recorded. */
export const AdminBackupStatus = z.object({
  finishedAt: Timestamp,
  result: z.enum(['ok', 'failed']),
  uploaded: z.number().int().nonnegative(),
  databases: z.string(),
});
export type AdminBackupStatus = z.infer<typeof AdminBackupStatus>;

/**
 * `GET /api/admin/overview` — the console's front page.
 *
 * Counts rather than lists: the question this page answers is "is anything
 * wrong?", and a list of 85,915 airports does not answer it. The airport count is
 * here for a specific reason — dev silently lost its entire airport dataset to a
 * misdirected test run in August 2026 and nobody noticed for hours. A tile
 * reading zero would have.
 */
export const AdminOverviewResponse = z.object({
  counts: z.object({
    players: z.number().int().nonnegative(),
    worlds: z.number().int().nonnegative(),
    admins: z.number().int().nonnegative(),
    airports: z.number().int().nonnegative(),
    auditEntries: z.number().int().nonnegative(),
  }),
  backup: AdminBackupStatus.nullable(),
  alerts: z.array(AdminAlert),
});
export type AdminOverviewResponse = z.infer<typeof AdminOverviewResponse>;

/**
 * A player as the console lists them (M1A-08).
 *
 * No email address here, deliberately. The list is the wide surface — it is what
 * a search returns, what a screenshot catches, and what a shoulder reads — and an
 * address is not needed to *find* someone. It appears on the detail view, where
 * looking is a deliberate act and is recorded as one.
 */
export const AdminPlayerSummary = z.object({
  id: Uuid,
  displayName: z.string().min(1),
  createdAt: Timestamp,
  /** Newest session activity, or null for an account that has never signed in since sessions existed. */
  lastSeenAt: Timestamp.nullable(),
  airlines: z.number().int().nonnegative(),
  /** True if this player holds an admin grant — worth seeing in a list of accounts. */
  isAdmin: z.boolean(),
});
export type AdminPlayerSummary = z.infer<typeof AdminPlayerSummary>;

/** `GET /api/admin/players?q=&limit=&offset=` */
export const AdminPlayerListResponse = z.object({
  players: z.array(AdminPlayerSummary),
  /** Matches for the query, which may exceed the page returned. */
  total: z.number().int().nonnegative(),
  /** Echoed back so a slow response cannot be rendered against a newer query. */
  query: z.string(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminPlayerListResponse = z.infer<typeof AdminPlayerListResponse>;

/**
 * One external identity.
 *
 * `subject` is the provider's stable account key — Google's `sub` — and is safe
 * to show: it identifies the account to the provider but authenticates nothing.
 * The email is informational, never used to match an identity to a player
 * (ADR-0004), and is shown here because support needs it to recognise who they
 * are talking to.
 */
export const AdminPlayerIdentity = z.object({
  provider: z.string().min(1),
  subject: z.string().min(1),
  email: z.string().nullable(),
  createdAt: Timestamp,
});
export type AdminPlayerIdentity = z.infer<typeof AdminPlayerIdentity>;

/**
 * One session, as metadata only.
 *
 * There is no field here that could carry a token, and that is structural rather
 * than careful: the database stores only a SHA-256 of it, and this shape has
 * nowhere to put one even if somebody tried.
 */
export const AdminPlayerSession = z.object({
  id: Uuid,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastSeenAt: Timestamp,
  /** Worked out on the server against its own clock, so a skewed browser cannot disagree. */
  expired: z.boolean(),
});
export type AdminPlayerSession = z.infer<typeof AdminPlayerSession>;

/** One airline this player holds, in one world. */
export const AdminPlayerAirline = z.object({
  id: Uuid,
  worldId: Uuid,
  worldName: z.string().min(1),
  name: z.string().min(1),
  iataCode: z.string(),
  icaoCode: z.string(),
  callsign: z.string(),
  /** Integer minor units, as stored. Formatting is the client's problem, not the wire's. */
  cashMinor: z.number().int(),
  reputation: z.number(),
  createdAt: Timestamp,
});
export type AdminPlayerAirline = z.infer<typeof AdminPlayerAirline>;

/** `GET /api/admin/players/:playerId` */
export const AdminPlayerDetail = z.object({
  id: Uuid,
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable(),
  createdAt: Timestamp,
  isAdmin: z.boolean(),
  identities: z.array(AdminPlayerIdentity),
  sessions: z.array(AdminPlayerSession),
  airlines: z.array(AdminPlayerAirline),
});
export type AdminPlayerDetail = z.infer<typeof AdminPlayerDetail>;

export const AdminPlayerDetailResponse = z.object({
  player: AdminPlayerDetail,
});
export type AdminPlayerDetailResponse = z.infer<typeof AdminPlayerDetailResponse>;
