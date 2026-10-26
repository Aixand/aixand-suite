import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results/carrier',
  testMatch: 'carrier.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.AIXAND_CARRIER_BASE_URL,
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
  },
})
