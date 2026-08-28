import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests exercise the production-shaped deployment: Fastify serves the
 * built Vite client and API from one origin.  Do not replace this with the Vite
 * development server — that would skip the artefact users receive and change
 * the session-cookie origin arrangement.
 */
const port = Number.parseInt(process.env.E2E_PORT ?? '3100', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `E2E_PORT must be a valid TCP port — got ${JSON.stringify(process.env.E2E_PORT)}.`,
  );
}

const configuredBaseUrl = process.env.E2E_BASE_URL;
const baseURL = configuredBaseUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // Keep browser specs physically outside the Vitest projects.  The explicit
  // path makes the separation contractual rather than an accident of globs.
  testMatch: '**/*.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL,
    // CI retries once, so the first retry preserves the diagnostic trace. A
    // local run has no retry, therefore retain its failing trace as well.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Supplying E2E_BASE_URL is an intentional escape hatch for diagnosing an
  // already-running local server. Normal and CI runs build before they start.
  webServer: configuredBaseUrl
    ? undefined
    : {
        command: 'node e2e/start-server.mjs',
        url: `${baseURL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
