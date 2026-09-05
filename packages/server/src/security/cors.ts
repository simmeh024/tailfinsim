import { type EnvironmentLabel } from '../env';

/**
 * What each environment is *permitted* to trust cross-origin (SEC-HARD-08).
 *
 * ## Why an allowlist of allowlists
 *
 * Tailfin's session is a cookie, so a permissive CORS policy is directly
 * exploitable: any page could read a signed-in player's airline, or an admin's
 * world list. And the usual route to one is not malice but convenience — a
 * setting added to unblock local development that nobody removes. `origin: true`
 * is the specific trap, because it *reflects* the requesting origin, which with
 * credentials is the worst configuration available and reads like "on".
 *
 * Tailfin runs the same build everywhere, differing only by environment
 * variables, so a setting added "just for dev" is one variable away from
 * production. A validator that merely rejected `*` would still let
 * `https://tailfinsim.com.evil.example` through on the live host.
 *
 * So the check is not "is this value dangerous?" but "is this value one of the
 * two or three origins this environment could possibly have a reason to trust?".
 * Production may name its own origin and nothing else. That makes a hostile
 * origin unconfigurable there rather than merely discouraged, and it kills the
 * lookalike-domain case by construction: exact string match against a fixed set,
 * never a prefix, suffix or regular expression.
 *
 * ## Today every non-empty value is refused, and that is not a contradiction
 *
 * This build registers no CORS plugin, so `CORS_ALLOWED_ORIGINS` cannot take
 * effect and setting it stops the server rather than being ignored — a variable
 * that silently does nothing is the shape of every long-running configuration
 * mystery. The table above still decides *which* refusal you get, because
 * "production may not trust that origin" and "this build has no CORS" are
 * different problems and only one of them is about the value.
 *
 * The absence is what [ADR-0025](../../../../docs/adr/0025-no-csrf-token.md)
 * rests on: no CORS is one of the four facts that make a CSRF token
 * unnecessary, and `security/csrf.test.ts` proves it over the wire. The day
 * that changes, this table is the only sanctioned way to build the list, and
 * ADR-0025 has to be amended in the same change.
 *
 * ## Local development should not need this at all
 *
 * `packages/web/vite.config.ts` proxies `/api` to the server, so the browser
 * sees one origin at `localhost:5173` and no cross-origin request is made.
 * Reach for the proxy first; the local entry below exists for the case where
 * someone is genuinely pointing a browser at two different ports.
 */
export const CORS_PERMITTED_ORIGINS: Record<EnvironmentLabel, readonly string[]> = {
  // Its own origin only. Same-origin already works without CORS, so naming it
  // is a no-op — which is the point: there is nothing useful to configure here,
  // and every hostile value is refused at boot rather than reviewed.
  production: ['https://tailfinsim.com'],
  dev: ['https://dev.tailfinsim.com'],
  // The Vite dev server and the API's own port.
  local: ['http://localhost:5173', 'http://localhost:3000'],
};

/** Values that mean "reflect whatever asked", spelled the various ways people try. */
const REFLECTING_VALUES = new Set(['*', 'true', 'all', 'any', 'null']);

/**
 * Turn `CORS_ALLOWED_ORIGINS` into the exact list the server may answer for.
 *
 * Throws rather than falling back, in the same spirit as the rest of `env.ts`:
 * a server that silently boots with a wider policy than intended is worse than
 * one that refuses to boot and says which value it refused.
 *
 * @param raw   The environment variable, unset or empty meaning **no CORS**.
 * @param label Which environment this process claims to be.
 */
export function resolveCorsOrigins(
  raw: string | undefined,
  label: EnvironmentLabel,
): readonly string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];

  const permitted = CORS_PERMITTED_ORIGINS[label];
  const requested = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  const refused: string[] = [];
  const accepted: string[] = [];

  for (const origin of requested) {
    // Named separately from the allowlist check so the error can say *why*
    // rather than only "not permitted" — a wildcard is a different mistake from
    // a typo, and deserves a different sentence.
    if (REFLECTING_VALUES.has(origin.toLowerCase())) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS may not contain ${JSON.stringify(origin)}. A reflecting or ` +
          'wildcard origin combined with credentialed requests lets any site read an ' +
          'authenticated response. Name the exact origins instead. See SEC-HARD-08 and ADR-0025.',
      );
    }
    if (permitted.includes(origin)) {
      accepted.push(origin);
      continue;
    }
    refused.push(origin);
  }

  if (refused.length > 0) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS contains ${refused.map((o) => JSON.stringify(o)).join(', ')}, which ` +
        `ENVIRONMENT_LABEL=${label} may not trust. Permitted here: ` +
        `${permitted.map((o) => JSON.stringify(o)).join(', ')}. This is an exact-match allowlist ` +
        'on purpose — a lookalike domain such as "https://tailfinsim.com.evil.example" is not a ' +
        'near miss, it is a different site. See SEC-HARD-08.',
    );
  }

  /*
   * Permitted by the table, and still refused — because this build has no CORS.
   *
   * The alternative is worse: accepting the value, registering nothing, and
   * leaving an operator to work out why the header they configured never
   * appears. A variable that silently does nothing is the shape of every
   * long-running configuration mystery.
   *
   * Reaching this branch means somebody wants cross-origin access for a real
   * reason, and the message is the handover: what to do instead, and what has to
   * change if "instead" is not enough. `accepted` is named so the sentence can
   * confirm the value itself was fine — the refusal is about the build, not
   * about their typing.
   */
  throw new Error(
    `CORS_ALLOWED_ORIGINS names ${accepted.map((o) => JSON.stringify(o)).join(', ')}, which ` +
      `ENVIRONMENT_LABEL=${label} is permitted to trust — but this build registers no CORS ` +
      'plugin at all, so the value would have no effect. That absence is deliberate: ADR-0025 ' +
      'treats it as one of the four facts that make a CSRF token unnecessary. For local ' +
      "development use Vite's `/api` proxy (packages/web/vite.config.ts) so the browser sees " +
      'one origin. If cross-origin access is genuinely needed, register the plugin with exactly ' +
      'this list, never `origin: true`, and amend ADR-0025 in the same change. See SEC-HARD-08.',
  );
}
