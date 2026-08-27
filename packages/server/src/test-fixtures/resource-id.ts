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
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'path',
    field: 'worldId',
    semantics: 'admin-authorized-resource',
  })),
  {
    endpoint: 'GET /api/fleet/airframes/:airframeId',
    position: 'path',
    field: 'airframeId',
    semantics: 'owner-scoped-resource',
  },
  ...[
    'PUT /api/routes/:routeId/fares',
    'GET /api/routes/:routeId/waterfall',
    'POST /api/routes/:routeId/fares/preview',
  ].map((endpoint): ResourceIdSurface => ({
    endpoint,
    position: 'path',
    field: 'routeId',
    semantics: 'owner-scoped-resource',
  })),
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
] as const satisfies readonly ResourceIdSurface[];
