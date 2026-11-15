import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['recovery.spec.ts'], outputDir: 'test-results/recovery',
  metadata: { mockAuthentication: true }, fullyParallel: true, workers: 2,
  use: { baseURL: 'http://127.0.0.1:5237', viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5237 --strictPort',
    url: 'http://127.0.0.1:5237', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
