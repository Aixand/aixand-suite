import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  testMatch: ['manager-suites.spec.ts', 'prompts.spec.ts', 'mcp.spec.ts', 'settings.spec.ts', 'chat-followups.spec.ts', 'chat-recovery.spec.ts', 'workflow-builder.spec.ts', 'agents-layout.spec.ts'],
  outputDir: process.env.SUITE_TEST_ARTIFACTS ?? 'test-results/managers',
  metadata: { mockAuthentication: true },
  fullyParallel: true,
  workers: 4,
  use: { baseURL: 'http://127.0.0.1:5227', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5227 --strictPort',
    url: 'http://127.0.0.1:5227', reuseExistingServer: false,
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
  },
})
