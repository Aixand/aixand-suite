import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'terminal-catalog.spec.ts',
    'terminal-cleanup.spec.ts',
    'terminal-focus.spec.ts',
    'terminal-sections.spec.ts',
    'terminal-status.spec.ts',
    'terminals.spec.ts',
    'terminal-layout.spec.ts',
    'terminal-context.spec.ts',
    'terminal-lifecycle.spec.ts',
    'terminal-recovery.spec.ts',
    'terminal-resize.spec.ts',
    'my-terminals.spec.ts',
    'groups.spec.ts',
    'inspector.spec.ts',
  ],
  outputDir: 'test-results/terminals',
  metadata: { mockAuthentication: true },
  fullyParallel: true,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5223',
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5223 --strictPort',
    url: 'http://127.0.0.1:5223',
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
    reuseExistingServer: false,
  },
})
