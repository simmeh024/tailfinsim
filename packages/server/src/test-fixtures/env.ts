import type { ServerEnv } from '../env';

/**
 * A complete `ServerEnv`, for tests that need one to build an app.
 *
 * ## Why this exists
 *
 * `ServerEnv`'s optional-in-practice fields are declared required-but-nullable
 * — `googleClientId: string | undefined` rather than `googleClientId?: string`
 * — which is the right choice for the interface: `loadEnv` must decide every
 * field, and a `?` would let it forget one. The cost lands on the tests, where
 * every hand-written literal has to restate the whole shape whether or not it
 * cares about any of it.
 *
 * Twenty-eight test files were carrying twenty-nine such literals, near-identical
 * down to the arbitrary letter each one repeated forty-eight times for its
 * session secret. Adding one configuration field was therefore a
 * twenty-eight-file change; AUTH-08, which adds four, patched them with a script
 * to stay reviewable and then threw that away when this landed first. The next
 * field costs one file, and it is this one.
 *
 * ## What the defaults describe
 *
 * The shipped, unconfigured state: **auth off**, the holding surface, the
 * `local` label, and a silent logger — the same directions `loadEnv` defaults
 * to when nothing is set. `publicOrigin` is deliberately `http`, not `https`,
 * so session cookies are not `Secure` and therefore travel under `inject()`.
 * The pool and timeout are small because no test should be waiting on either.
 *
 * `databaseUrl` follows `DATABASE_URL` when it is set and falls back to a
 * sentinel that cannot connect. A test that must *never* reach a database
 * should override it with a named sentinel of its own — `cors.test.ts`,
 * `rate-limit.test.ts` and `route-inventory.ts` do — so that an accidental
 * connection attempt names the test that made it.
 *
 * Override only what a test genuinely varies. A field restated at its default
 * is noise, and worse, it reads as a decision.
 */
export function makeTestEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    nodeEnv: 'test',
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://unused',
    databasePoolMax: 2,
    databaseConnectTimeoutMs: 5_000,
    logLevel: 'silent',
    webSurface: 'holding',
    environmentLabel: 'local',
    publicOrigin: 'http://localhost:3000',
    googleClientId: undefined,
    googleClientSecret: undefined,
    discordClientId: undefined,
    discordClientSecret: undefined,
    sessionSecret: undefined,
    googleEnabled: false,
    discordEnabled: false,
    authEnabled: false,
    sessionTtlHours: 24,
    adminSessionTtlHours: 12,
    allowRegistration: false,
    ...overrides,
  };
}

/**
 * The same env with Google OAuth configured and `authEnabled` true.
 *
 * Most tests want this one: a signed-in player is the precondition for nearly
 * every route, so `makeTestEnv` alone leaves them unable to sign anybody in.
 * It is a separate factory rather than the default because `loadEnv`'s default
 * is auth *off*, and a fixture whose default quietly disagrees with the real
 * loader is a fixture that stops describing the thing it stands in for.
 *
 * It sets all four auth fields together, which makes `env.ts`'s
 * half-configured trap — credentials without a secret, or either without
 * `authEnabled` — unrepresentable at a call site.
 *
 * The credential values are arbitrary and shared. They were arbitrary and
 * *unshared* before, which is how the tree came to hold five different
 * forty-eight-character secrets; nothing asserts on any of them, and
 * `session-cookie.test.ts` reads the client id back off the env rather than
 * naming it.
 */
export function makeAuthedTestEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return makeTestEnv({
    googleClientId: 'test-client-id.apps.googleusercontent.com',
    googleClientSecret: 'test-client-secret',
    sessionSecret: 'a'.repeat(48),
    googleEnabled: true,
    authEnabled: true,
    ...overrides,
  });
}

/**
 * Google *and* Discord configured, for the cases that need two ways in (AUTH-08).
 *
 * Separate from `makeAuthedTestEnv` rather than folded into it, because most
 * tests want the ordinary one-provider instance and a second button on every
 * login-page assertion would be noise. Reach for this only when the *number* of
 * providers is the thing under test.
 */
export function makeMultiProviderTestEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return makeAuthedTestEnv({
    discordClientId: '000000000000000000',
    discordClientSecret: 'test-discord-client-secret',
    discordEnabled: true,
    ...overrides,
  });
}
