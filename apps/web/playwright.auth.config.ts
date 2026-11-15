import { defineConfig } from '@playwright/test'

export default defineConfig({
  outputDir: 'test-results/auth',
  testDir: './tests',
  testMatch: /auth(?:-local-setup)?\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5198',
    viewport: { width: 1200, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/start-test-server.mjs',
      url: 'http://127.0.0.1:3198/api/health',
      timeout: 120_000,
      env: {
        HOST: '127.0.0.1',
        PORT: '3198',
        CORS_ORIGINS: 'http://127.0.0.1:5198',
        AIXAND_TEST_SETUP_PENDING: '1',
      },
    },
    {
      command: 'npm run dev -- --port 5198 --strictPort',
      url: 'http://127.0.0.1:5198',
      env: { AIXAND_SERVER_URL: 'http://127.0.0.1:3198' },
    },
  ],
})
