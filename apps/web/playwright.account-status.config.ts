import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: ['account-status.spec.ts', 'agents-sdk.spec.ts', 'profile-management.spec.ts'],
  metadata: { mockAuthentication: true }, outputDir: 'test-results/account-status',
  fullyParallel: true, workers: 2,
  use: { baseURL: 'http://127.0.0.1:5216', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5216 --strictPort',
    url: 'http://127.0.0.1:5216', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
