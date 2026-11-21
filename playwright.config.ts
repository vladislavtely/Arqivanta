import { defineConfig, devices } from '@playwright/test';

const port = process.env.ARQIVANTA_TEST_PORT ?? '4321';
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: url,
    channel: process.env.ARQIVANTA_TEST_BROWSER,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node apps/server/src/index.ts',
    url: `${url}/api/health`,
    env: { ARQIVANTA_PORT: port, ARQIVANTA_DATA_DIR: '.arqivanta/e2e' },
    reuseExistingServer: false,
  },
});
