/**
 * Canonical hostile resource identifiers for SEC-07 integration tests.
 *
 * UUID syntax proves only that Postgres can compare the value. It does not prove
 * that the row exists, that it is the right entity kind, or that the caller owns
 * it. Keeping the four cases in one table makes those distinctions explicit at
 * every HTTP position instead of leaving each endpoint to invent its own set.
 */

export const ABSENT_RESOURCE_UUID = '00000000-0000-4000-8000-000000000000';

export const MALFORMED_RESOURCE_IDS = [
  '',
  'not-a-uuid',
  `${ABSENT_RESOURCE_UUID} `,
  // Longer than Fastify's default 100-character parameter ceiling, but short
  // enough that the HTTP parser reaches route matching instead of rejecting the
  // entire URI as 414 before the application can apply its 400/404 policy.
  'x'.repeat(256),
] as const;

export type ResourceIdCaseKind = 'own' | 'another-player' | 'absent' | 'wrong-entity';

export interface ResourceIdCase {
  kind: ResourceIdCaseKind;
  id: string;
  /** Whether an owner-scoped endpoint may resolve this value. */
  expected: 'allow' | 'conceal';
}

export interface ResourceIdCaseValues {
  own: string;
  anotherPlayer: string;
  wrongEntity: string;
  absent?: string;
}

/** The four-ID matrix from SEC-07, in a stable order for `it.each` and diagnostics. */
export function resourceIdCases(values: ResourceIdCaseValues): readonly ResourceIdCase[] {
  return [
    { kind: 'own', id: values.own, expected: 'allow' },
    { kind: 'another-player', id: values.anotherPlayer, expected: 'conceal' },
    {
      kind: 'absent',
      id: values.absent ?? ABSENT_RESOURCE_UUID,
      expected: 'conceal',
    },
    { kind: 'wrong-entity', id: values.wrongEntity, expected: 'conceal' },
  ];
}

export type ResourceIdPosition = 'path' | 'query' | 'body' | 'header';
export type ResourceIdSemantics =
  | 'admin-authorized-resource'
  | 'owner-scoped-resource'
  | 'public-parent-resource'
  | 'context-selector'
  | 'computed-selector'
  | 'client-generated-token';

export interface ResourceIdSurface {
  endpoint: string;
  position: ResourceIdPosition;
  field: string;
  semantics: ResourceIdSemantics;
}

/**
 * Every current HTTP input whose value is an identifier rather than ordinary
 * prose or a bounded enum. Path entries are checked against Fastify's live route
 * table by `security/resource-id-inventory.test.ts`; the remaining entries make
 * body, query and header positions reviewable instead of invisible in handlers.
 */
export const RESOURCE_ID_SURFACES = [
  {
    endpoint: 'GET /api/admin/players/:playerId',
    position: 'path',
    field: 'playerId',
    semantics: 'admin-authorized-resource',
  },
  {
    endpoint: 'POST /api/admin/players/:playerId/sessions/revoke',
    position: 'path',
    field: 'playerId',
    semantics: 'admin-authorized-resource',
  },
  {
    endpoint: 'GET /api/admin/airlines/:airlineId',
    position: 'path',
    field: 'airlineId',
    semantics: 'admin-authorized-resource',
  },
  {
    endpoint: 'PATCH /api/admin/airlines/:airlineId/identity',
    position: 'path',
    field: 'airlineId',
    semantics: 'admin-authorized-resource',
  },
  ...[
    'POST /api/admin/worlds/:worldId/speed',
    'POST /api/admin/worlds/:worldId/status',
    'POST /api/admin/worlds/:worldId/reset',
    'POST /api/admin/worlds/:worldId/economy-config',
    'GET /api/admin/worlds/:worldId/npc',
    'GET /api/admin/worlds/:worldId/config',
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'path',
    field: 'worldId',
    semantics: 'admin-authorized-resource',
  })),
  {
    endpoint: 'DELETE /api/ground/contracts/:id',
    position: 'path',
    field: 'id',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'DELETE /api/ground/self-handling/:id',
    position: 'path',
    field: 'id',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'GET /api/fleet/airframes/:airframeId',
    position: 'path',
    field: 'airframeId',
    semantics: 'owner-scoped-resource',
  },
  ...[
    'PUT /api/routes/:routeId/fares',
    'GET /api/routes/:routeId/waterfall',
    'GET /api/routes/:routeId/performance',
    'GET /api/routes/:routeId/flights',
    'GET /api/routes/:routeId/diagnosis',
    'GET /api/routes/:routeId/competition',
    'POST /api/routes/:routeId/fares/preview',
    'DELETE /api/routes/:routeId',
    'PUT /api/routes/:routeId/active',
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'path',
    field: 'routeId',
    semantics: 'owner-scoped-resource',
  })),
  ...['PUT /api/schedules/:id', 'PUT /api/schedules/:id/active', 'DELETE /api/schedules/:id'].map(
    (endpoint): ResourceIdSurface => ({
      endpoint,
      position: 'path',
      field: 'id',
      semantics: 'owner-scoped-resource',
    }),
  ),
  // Service packages and route groups (M8-03). Owner-scoped in the ordinary way:
  // the store queries carry the session's airline, so another player's id is not
  // found rather than found and refused.
  ...[
    'PUT /api/service/packages/:id',
    'DELETE /api/service/packages/:id',
    'PUT /api/service/route-groups/:id',
    'DELETE /api/service/route-groups/:id',
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'path',
    field: 'id',
    semantics: 'owner-scoped-resource',
  })),
  // The routes a group is being given, and the package it is being assigned.
  // Both are the caller's own resources named in a body, and both are checked
  // against the resolved owner before anything is written.
  {
    endpoint: 'POST /api/credit/loans securedAirframeId',
    position: 'body',
    field: 'securedAirframeId',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'POST /api/service/payback routeGroupId',
    position: 'body',
    field: 'routeGroupId',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'POST /api/service/route-groups routeIds',
    position: 'body',
    field: 'routeIds',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'PUT /api/service/route-groups/:id routeIds',
    position: 'body',
    field: 'routeIds',
    semantics: 'owner-scoped-resource',
  },
  {
    endpoint: 'PUT /api/service/route-groups/:id servicePackageId',
    position: 'body',
    field: 'servicePackageId',
    semantics: 'owner-scoped-resource',
  },
  ...['POST /api/airlines/code-availability', 'POST /api/airlines'].map(
    (endpoint): ResourceIdSurface => ({
      endpoint,
      position: 'body',
      field: 'worldId',
      semantics: 'public-parent-resource',
    }),
  ),
  {
    endpoint: 'POST /api/fleet/acquisitions',
    position: 'body',
    field: 'listingId',
    semantics: 'context-selector',
  },
  {
    endpoint: 'POST /api/fleet/maintenance/checks',
    position: 'body',
    field: 'airframeId',
    semantics: 'owner-scoped-resource',
  },
  ...[
    'POST /api/crew/hires',
    'POST /api/crew/conversions',
    'PUT /api/crew/reserves',
    'PUT /api/crew/policies',
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'body',
    field: 'crewBaseId',
    semantics: 'owner-scoped-resource',
  })),
  {
    endpoint: 'player-airline context',
    position: 'header',
    field: 'x-tailfin-world-id',
    semantics: 'context-selector',
  },
  /*
   * §14's metric id (M8-09). A **selector over a fixed server-side enum**, not
   * an owned resource: it names nothing the player has, so there is no
   * cross-owner case to conceal and an unknown one is a 404 because the metric
   * does not exist. The data behind it is still scoped to the resolved owner —
   * SEC-07 asks for the classification to be explicit rather than for every id
   * to be treated as a resource, and treating this one as a resource would
   * invent an ownership question that has no answer.
   */
  {
    endpoint: 'GET /api/statistics/:metricId/breakdown',
    position: 'path',
    field: 'metricId',
    semantics: 'computed-selector',
  },
  {
    endpoint: 'GET /api/statistics/:metricId/breakdown',
    position: 'query',
    field: 'by',
    semantics: 'computed-selector',
  },
  {
    endpoint: 'GET /api/routes/:routeId/waterfall',
    position: 'query',
    field: 'rival',
    semantics: 'computed-selector',
  },
  {
    endpoint: 'POST /api/fleet/acquisitions',
    position: 'body',
    field: 'requestId',
    semantics: 'client-generated-token',
  },
  /*
   * M8-13. `throughAt` names no resource — it is a game-time instant selecting
   * how much of the digest the player is acknowledging. Registered anyway,
   * because the thing this matrix exists to make reviewable is a **client value
   * that decides scope**, and this one decides which period's events the server
   * will never show again. `markDigestRead` clamps it to the world's own game
   * time and only ever moves the watermark forward, so a forged or stale value
   * can neither skip an unseen period nor replay a dismissed one.
   */
  {
    endpoint: 'POST /api/digest/read',
    position: 'body',
    field: 'throughAt',
    semantics: 'computed-selector',
  },
] as const satisfies readonly ResourceIdSurface[];
