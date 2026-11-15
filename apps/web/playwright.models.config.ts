import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: 'chat-models.spec.ts', outputDir: 'test-results/model-discovery',
  metadata: { mockAuthentication: true }, workers: 2,
  use: { baseURL: 'http://127.0.0.1:5229', viewport: { width: 1440, height: 1100 } },
  webServer: { command: 'node_modules/.bin/vite --host 127.0.0.1 --port 5229 --strictPort',
    url: 'http://127.0.0.1:5229', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' } },
})
