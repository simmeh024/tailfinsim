# Browser tests

`pnpm test:e2e` installs Chromium if needed, then runs Playwright against the
production-shaped local app: it builds the Vite client, then starts Fastify with `WEB_SURFACE=app` on
`http://127.0.0.1:3100`. The client and API therefore share the same origin,
as they do in production. Provide a disposable database in `DATABASE_URL`;
E2E-02 will add the dedicated database, reset and seed helpers.

Commands:

- `pnpm test:e2e` — all browser specifications.
- `pnpm test:e2e:smoke` — the small `@smoke` PR subset.
- `pnpm test:e2e:ui` — Playwright's local interactive runner.

Set `E2E_PORT` to choose a different local port. `E2E_BASE_URL` deliberately
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

## Authentication boundary

The only supported test authentication will be real database-backed sessions
minted during global setup (E2E-03). Do not add a test login endpoint or an
environment bypass to the server. Google OAuth callback coverage remains in
the server suite until a deliberate provider-mock decision is made; browser
specs must never store session tokens in committed files, logs or CI artefacts.
