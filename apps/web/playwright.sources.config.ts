import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests', testMatch: 'resource-sources.spec.ts', outputDir: 'test-results/resource-sources', workers: 1,
  metadata: { mockAuthentication: true }, use: { baseURL: 'http://127.0.0.1:5231', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: { command: 'node_modules/.bin/vite --host 127.0.0.1 --port 5231 --strictPort', url: 'http://127.0.0.1:5231', reuseExistingServer: false, env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' } } })
