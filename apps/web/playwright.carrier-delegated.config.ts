import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: 'carrier-delegated.spec.ts', workers: 1,
  outputDir: process.env.SUITE_TEST_ARTIFACTS ? `${process.env.SUITE_TEST_ARTIFACTS}/playwright` : 'test-results/carrier-delegated',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:18764', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/test-vite-live.mjs --port 18764', url: 'http://127.0.0.1:18764', reuseExistingServer: false,
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' } },
})
