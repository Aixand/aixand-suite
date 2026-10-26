import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['profile-management.spec.ts', 'agents-operations.spec.ts'],
  outputDir: 'test-results/profile-management', metadata: { mockAuthentication: true },
  fullyParallel: true, workers: 2,
  use: { baseURL: 'http://127.0.0.1:5206', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5206 --strictPort',
    url: 'http://127.0.0.1:5206', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
