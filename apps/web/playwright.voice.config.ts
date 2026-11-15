import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['voice.spec.ts', 'chat-models.spec.ts', 'conversation.spec.ts'],
  outputDir: 'test-results/voice',
  metadata: { mockAuthentication: true },
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5198',
    viewport: { width: 1440, height: 1000 },
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5198 --strictPort',
    url: 'http://127.0.0.1:5198',
    reuseExistingServer: !process.env.CI,
  },
})
