# Browser tests

`pnpm test:e2e` installs Chromium if needed, then runs Playwright against the
production-shaped local app: it first migrates and resets the dedicated E2E database, then builds the Vite client and starts Fastify with `WEB_SURFACE=app` on
`http://127.0.0.1:3100`. The client and API therefore share the same origin,
as they do in production. It targets `tailfin_e2e_test` by default, never the
application database. Create that database once in local Postgres, then the
harness applies migrations and creates its deterministic fixture world, player
and administrator on every run.

Commands:

- `pnpm test:e2e` — all browser specifications.
- `pnpm test:e2e:smoke` — the small `@smoke` PR subset.
- `pnpm test:e2e:ui` — Playwright's local interactive runner.

Set `E2E_PORT` to choose a different local port and `E2E_DATABASE_URL` only
when it points at another disposable `_test` or `_ci` database. `E2E_BASE_URL` deliberately
skips the managed server for debugging an already-running local instance; CI
must not use it, because CI must test a newly built artefact.

## Layout and conventions

Keep specs in the directory that names their journey:

```
e2e/
  smoke/       # small, PR-worthy journeys
  admin/       # administration-console journeys
  degraded/    # failure-state journeys
  fixtures/    # setup helpers as the suite grows
```

Name files `*.spec.ts` and tests after a user-observable outcome. Use role,
label and visible-name locators such as `getByRole('link', { name: 'Sign out' })`.
Do not use CSS selectors, positional locators, or `waitForTimeout`: Playwright
should wait for the actual visible result, response, URL or accessible state.

The suite is intentionally outside `packages/*/src`, so Vitest cannot collect
Playwright specs. Playwright's `testDir` and `testMatch` make the reverse true.

CI retries once and keeps a trace for that retry; local runs do not retry and
retain a trace only when they fail. Screenshots are captured only on failure;
video is disabled. Do not use `test.only`: CI rejects it.

## Admin-console journeys

`e2e/admin/console.spec.ts` keeps its broken-page sentinel in the `@smoke`
subset. Its remaining journeys are intentionally broader: live console
navigation, real world health, a world creation plus audit trail, confirmation
controls, and player-view auditing. The creation test uses the fixed
`E2E Admin Created World` staging world; preparation removes only that exact
disposable row before the next run. It never submits a reset or changes the
fixture world's lifecycle or speed.

## Authentication boundary

The only supported test authentication is real database-backed sessions minted
once during global setup (E2E-03). `player.json`, `admin.json`, and the
logout-only `logout-player.json` are temporary Playwright storage states,
reused by tests in a run and removed afterwards. The logout identity prevents a
sign-out journey from revoking the player session another parallel spec needs.
Do not add a test login endpoint or an environment bypass to the server.

The server runs with normal authentication enabled, but setup writes the opaque
`tailfin_session` cookie only after calling the ordinary `createSession()`
function. Google is never called. The callback's exchange, identity matching
and first-sign-in creation remain server-test coverage until a deliberate
provider-mock decision is made. Browser specs must never log, commit or upload
session tokens or their storage-state files.

## Database boundary

The preparation step calls the same `assertDisposableDatabaseUrl()` guard used
by the server test suite **before** it opens a connection. It refuses a URL
whose database is not named `*_test` or `*_ci`. The default
`tailfin_e2e_test` is separate from both `tailfin`/`tailfin_dev` and the unit
suite's `tailfin_test`.

Each run resets the named E2E world, replaces only the named E2E player and
administrator, and creates the admin grant through the normal audited path.
It does not truncate `admin_audit` (the database forbids that) and it does not
delete or import reference data such as airports and runways. Import reference
data once when a journey needs it; it remains available for later runs.
