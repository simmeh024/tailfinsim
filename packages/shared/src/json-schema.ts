import { z } from 'zod';

import {
  AdminAuditResponse,
  AdminCreateWorldResponse,
  AdminListResponse,
  AdminOverviewResponse,
  AdminSpeedChangeResponse,
  AdminWorldListResponse,
} from './admin';
import { ApiError, HealthResponse } from './api';
import { LogoutResponse, MeResponse } from './auth';
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
export const versionResponseJsonSchema = z.toJSONSchema(VersionResponse);
export const adminAuditResponseJsonSchema = z.toJSONSchema(AdminAuditResponse);
export const adminListResponseJsonSchema = z.toJSONSchema(AdminListResponse);
export const adminWorldListResponseJsonSchema = z.toJSONSchema(AdminWorldListResponse);
export const adminCreateWorldResponseJsonSchema = z.toJSONSchema(AdminCreateWorldResponse);
export const adminOverviewResponseJsonSchema = z.toJSONSchema(AdminOverviewResponse);
export const adminSpeedChangeResponseJsonSchema = z.toJSONSchema(AdminSpeedChangeResponse);

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
