import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: 'managed.spec.ts', outputDir: 'test-results/managed',
  metadata: { mockAuthentication: true }, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5207', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node_modules/.bin/vite --host 127.0.0.1 --port 5207 --strictPort',
    url: 'http://127.0.0.1:5207', reuseExistingServer: false,
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' } },
})
