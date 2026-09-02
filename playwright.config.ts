import { defineConfig, devices } from '@playwright/test';

const existingFrontend = process.env.PLAYWRIGHT_BASE_URL;
const testRunId = process.env.PEL_UI_TEST_ID ?? String(process.pid);
const apiPort = Number(process.env.PEL_UI_API_PORT ?? 47831);
const frontendPort = Number(process.env.PEL_UI_FRONTEND_PORT ?? 47832);
const apiURL = `http://127.0.0.1:${apiPort}`;
const frontendURL = `http://localhost:${frontendPort}`;
const webServer = [
  {
    command: `.venv/bin/policy-evidence-ledger serve --instance-dir instance/ui-test-${testRunId} --port ${apiPort}`,
    url: `${apiURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
];

if (!existingFrontend) {
  webServer.push({
    command: `PEL_API_URL=${apiURL} npm run dev -- --host localhost --port ${frontendPort}`,
    url: frontendURL,
    reuseExistingServer: false,
    timeout: 120_000,
  });
}

export default defineConfig({
  testDir: './tests/ui',
  testIgnore: '**/capture.spec.ts',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: existingFrontend ?? frontendURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer,
});
