import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3102',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 10000,
    navigationTimeout: 15000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:3102/api/health',
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      PORT: '3102',
      APP_URL: 'http://localhost:3102',
      PGLITE_DIR: '.data/e2e-postgres',
      BOARD_DIR: '.data/e2e-boards',
      NODE_ENV: 'development',
      DATABASE_URL: '',
      OPENAI_API_KEY: '',
      BETTER_AUTH_SECRET: 'e2e-test-secret-not-used-outside-tests-1234567890',
    },
  },
});
