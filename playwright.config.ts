import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['PORT'] ?? 4173);

/**
 * Escape hatch for environments that already ship a Chromium build which does
 * not match the one this Playwright version downloads. CI installs the
 * matching browser and leaves this unset.
 */
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

/**
 * E2E configuration.
 *
 * `dist/` must be built first; `bun run test:e2e` does that for you.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'list' : 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: `bun run tests/e2e/server.ts`,
    url: `http://127.0.0.1:${PORT}/panel.html`,
    reuseExistingServer: !process.env['CI'],
    env: { PORT: String(PORT) },
    stdout: 'ignore',
  },
});
