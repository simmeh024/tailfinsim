import type { FastifyRequest } from 'fastify';

type RequestBodyParser<Result> =
  ((input: unknown) => Result) | { safeParse: (input: unknown) => Result };

/**
 * The only production boundary allowed to expose Fastify's raw request body.
 *
 * Handlers receive only the parser's result. Keeping the raw read here makes
 * SEC-06 enforceable with lint: a future handler that reaches into
 * `request.body` fails before it can accidentally mass-assign a privileged
 * field.
 */
export function parseRequestBody<Result>(
  request: Pick<FastifyRequest, 'body'>,
  parser: RequestBodyParser<Result>,
): Result {
  return typeof parser === 'function' ? parser(request.body) : parser.safeParse(request.body);
}
