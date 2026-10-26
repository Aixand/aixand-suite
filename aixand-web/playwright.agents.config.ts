import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  projects: [
    { name: 'agents', testMatch: ['agents-content.spec.ts', 'agents-layout.spec.ts', 'agents-operations.spec.ts', 'agents-sdk.spec.ts', 'sessions.spec.ts'] },
    { name: 'agent-mcp', testMatch: 'mcp.spec.ts', grep: /profile MCP defaults|project preparation/ },
  ],
  outputDir: 'test-results/agents-ui',
  metadata: { mockAuthentication: true },
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
    reuseExistingServer: false,
  },
})
