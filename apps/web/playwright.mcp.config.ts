import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: 'mcp.spec.ts', outputDir: 'test-results/mcp',
  metadata: { mockAuthentication: true }, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5198', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: !process.env.CI },
})
