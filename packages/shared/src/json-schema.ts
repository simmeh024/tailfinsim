import { z } from 'zod';

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
