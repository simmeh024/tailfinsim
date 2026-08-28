import { defineConfig, devices } from '@playwright/test';

import { postDeploySmoke } from './post-deploy/config';

/**
 * A deliberately separate runner for a URL that is already deployed. It has
 * no web-server command, fixture database, auth setup or CI-spec discovery.
 * Keeping that boundary in configuration means a data-writing E2E spec cannot
 * be included in a production smoke run by a broad glob.
 */
export default defineConfig({
  testDir: './post-deploy',
  testMatch: '**/*.spec.ts',
  outputDir: 'post-deploy-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: postDeploySmoke.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
