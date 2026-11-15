import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['onboarding-native.spec.ts', 'onboarding.spec.ts', 'project-onboarding.spec.ts', 'product-onboarding.spec.ts', 'loading.spec.ts'],
  outputDir: 'test-results/onboarding',
  metadata: { mockAuthentication: true },
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:5240',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5240 --strictPort',
    url: 'http://127.0.0.1:5240',
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
    reuseExistingServer: false,
  },
})
