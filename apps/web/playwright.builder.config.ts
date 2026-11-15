import { defineConfig } from '@playwright/test'

// UI and compiler checks use a mocked transport; the live script uses Runner.
export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results/builder',
  metadata: { mockAuthentication: true },
  testMatch: [
    'connection-recovery.spec.ts',
    'workflow-builder.spec.ts',
    'workflow-library.spec.ts',
    'workflow-sequence.spec.ts',
    'workflow-terminal.spec.ts',
    'workflow-brain.spec.ts',
    'project-audit.spec.ts',
    'workflow-run.spec.ts',
    'workflow-amendments.spec.ts',
    'app.spec.ts',
    'loading.spec.ts',
    'home.spec.ts',
  ],
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5197',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197',
    reuseExistingServer: !process.env.CI,
  },
})
