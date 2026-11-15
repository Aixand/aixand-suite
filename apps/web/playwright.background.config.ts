import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['conversation.spec.ts', 'chat-navigation.spec.ts'], outputDir: 'test-results/background',
  metadata: { mockAuthentication: true }, fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5228', viewport: { width: 1440, height: 1100 }, trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 5228 --strictPort',
    url: 'http://127.0.0.1:5228', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' } },
})
