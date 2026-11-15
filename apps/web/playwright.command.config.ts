import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['command.spec.ts'], outputDir: 'test-results/command',
  metadata: { mockAuthentication: true }, fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5217', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5217 --strictPort',
    url: 'http://127.0.0.1:5217', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
