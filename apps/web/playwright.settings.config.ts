import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: 'settings.spec.ts', outputDir: 'test-results/settings',
  metadata: { mockAuthentication: true }, fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5204', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5204 --strictPort',
    url: 'http://127.0.0.1:5204', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
