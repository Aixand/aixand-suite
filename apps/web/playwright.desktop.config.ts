import { defineConfig } from '@playwright/test'

const port = Number(process.env.AIXAND_DESKTOP_TEST_PORT || 18753)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop test port')
const baseURL = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './desktop-tests',
  outputDir: 'test-results/desktop',
  use: { baseURL, viewport: { width: 640, height: 760 }, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/desktop-launcher-test-server.mjs', url: baseURL },
})
