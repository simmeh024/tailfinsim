import { z } from 'zod';

import {
  AdminAuditResponse,
  AdminCreateEconomyConfigResponse,
  AdminCreateWorldResponse,
  AdminEconomyConfigDetailResponse,
  AdminEconomyConfigListResponse,
  AdminListResponse,
  AdminOverviewResponse,
  AdminAirlineDetailResponse,
  AdminPlayerDetailResponse,
  AdminPinEconomyConfigResponse,
  AdminRequeueEventsResponse,
  AdminPlayerListResponse,
  AdminWorldHealthResponse,
  AdminSystemHealthResponse,
  AdminResetWorldResponse,
  AdminSpeedChangeResponse,
  AdminWorldStatusResponse,
  AdminWorldListResponse,
} from './admin';
import { FleetCatalogueResponse } from './aircraft-catalogue';
import {
  AirlineFoundingAirportListResponse,
  AirlineFoundingOptionsResponse,
  AirlineCodeAvailabilityResponse,
  AirlineCodeUnavailableError,
  CreateAirlineResponse,
  ForceRenameAirlineResponse,
  OwnAirlineResponse,
  UpdateOwnAirlineResponse,
} from './airline';
import { ApiError, HealthResponse } from './api';
import { LogoutResponse, MeResponse, RevokeSessionsResponse } from './auth';
import { AdminNpcResponse } from './npc';
import { VersionResponse } from './version';

/**
 * JSON Schema versions of the wire schemas, for consumers that speak JSON
 * Schema rather than zod — principally Fastify, whose validation and
 * serialisation are JSON-Schema based.
 *
 * These are **derived, not written**. `z.toJSONSchema` converts the same zod
 * schema the rest of the codebase uses, so there is still exactly one
 * definition of each shape. Doing the conversion here rather than in the server
 * keeps zod as this package's concern and means the server needs no direct
 * dependency on it.
 *
 * Fastify serialises responses *through* these, which strips anything not
 * declared. A field that leaks into a handler's return value cannot reach a
 * client unless the schema admits it.
 */

export const healthResponseJsonSchema = z.toJSONSchema(HealthResponse);
export const apiErrorJsonSchema = z.toJSONSchema(ApiError);
export const meResponseJsonSchema = z.toJSONSchema(MeResponse);
export const logoutResponseJsonSchema = z.toJSONSchema(LogoutResponse);
export const revokeSessionsResponseJsonSchema = z.toJSONSchema(RevokeSessionsResponse);
export const versionResponseJsonSchema = z.toJSONSchema(VersionResponse);
export const createAirlineResponseJsonSchema = z.toJSONSchema(CreateAirlineResponse);
export const airlineFoundingOptionsResponseJsonSchema = z.toJSONSchema(
  AirlineFoundingOptionsResponse,
);
export const airlineFoundingAirportListResponseJsonSchema = z.toJSONSchema(
  AirlineFoundingAirportListResponse,
);
export const airlineCodeAvailabilityResponseJsonSchema = z.toJSONSchema(
  AirlineCodeAvailabilityResponse,
);
export const airlineCodeUnavailableErrorJsonSchema = z.toJSONSchema(AirlineCodeUnavailableError);
export const forceRenameAirlineResponseJsonSchema = z.toJSONSchema(ForceRenameAirlineResponse);
export const ownAirlineResponseJsonSchema = z.toJSONSchema(OwnAirlineResponse);
export const updateOwnAirlineResponseJsonSchema = z.toJSONSchema(UpdateOwnAirlineResponse);
export const adminAuditResponseJsonSchema = z.toJSONSchema(AdminAuditResponse);
export const adminListResponseJsonSchema = z.toJSONSchema(AdminListResponse);
export const adminWorldListResponseJsonSchema = z.toJSONSchema(AdminWorldListResponse);
export const adminCreateWorldResponseJsonSchema = z.toJSONSchema(AdminCreateWorldResponse);
export const adminOverviewResponseJsonSchema = z.toJSONSchema(AdminOverviewResponse);
export const adminAirlineDetailResponseJsonSchema = z.toJSONSchema(AdminAirlineDetailResponse);
export const adminPlayerListResponseJsonSchema = z.toJSONSchema(AdminPlayerListResponse);
export const adminPlayerDetailResponseJsonSchema = z.toJSONSchema(AdminPlayerDetailResponse);
export const adminWorldHealthResponseJsonSchema = z.toJSONSchema(AdminWorldHealthResponse);
export const adminSystemHealthResponseJsonSchema = z.toJSONSchema(AdminSystemHealthResponse);
export const adminSpeedChangeResponseJsonSchema = z.toJSONSchema(AdminSpeedChangeResponse);
export const adminWorldStatusResponseJsonSchema = z.toJSONSchema(AdminWorldStatusResponse);
export const adminResetWorldResponseJsonSchema = z.toJSONSchema(AdminResetWorldResponse);

/*
 * Responses only, and deliberately.
 *
 * `z.toJSONSchema` emits draft 2020-12, which Fastify's serialiser is happy to
 * consume but its *validator* is not: attaching one of these as a route `body`
 * schema fails at startup with `no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"`. Request bodies are validated
 * with the zod schemas directly inside the handlers instead, which also gives
 * refusals in words an admin can act on rather than "body/speedMultiplier must
 * be > 0".
 */

export const adminEconomyConfigListResponseJsonSchema = z.toJSONSchema(
  AdminEconomyConfigListResponse,
);
export const adminEconomyConfigDetailResponseJsonSchema = z.toJSONSchema(
  AdminEconomyConfigDetailResponse,
);
export const adminCreateEconomyConfigResponseJsonSchema = z.toJSONSchema(
  AdminCreateEconomyConfigResponse,
);
export const adminPinEconomyConfigResponseJsonSchema = z.toJSONSchema(
  AdminPinEconomyConfigResponse,
);

export const adminNpcResponseJsonSchema = z.toJSONSchema(AdminNpcResponse);

export const fleetCatalogueResponseJsonSchema = z.toJSONSchema(FleetCatalogueResponse);

export const adminRequeueEventsResponseJsonSchema = z.toJSONSchema(AdminRequeueEventsResponse);
