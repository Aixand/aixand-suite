import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

function testPort(value: string | undefined, fallback: number) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Test ports must be integers between 1 and 65535')
  return String(port)
}
const apiPort = testPort(process.env.AIXAND_TEST_API_PORT, 3199)
const webPort = testPort(process.env.AIXAND_TEST_WEB_PORT, 5191)
const origin = `http://127.0.0.1:${webPort}`
const api = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results/browser',
  testIgnore: 'auth.spec.ts',
  fullyParallel: true,
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'cargo build --locked --manifest-path ../server/workflow-bridge/Cargo.toml --target-dir ../../workflow/ir/target && node scripts/start-test-server.mjs',
      url: `${api}/api/health`,
      timeout: 180_000,
      env: {
        HOST: '127.0.0.1',
        PORT: apiPort,
        CORS_ORIGINS: origin,
        WORKFLOW_BRIDGE_PATH: resolve(
          '../../workflow/ir/target/debug/aixand-workflow-bridge',
        ),
        WORKFLOW_SDK_CONFIG: '',
        WORKFLOW_CATALOG_PATHS: '',
        WORKFLOW_PYTHON_BIN: '',
      },
    },
    {
      command: `npm run dev -- --port ${webPort} --strictPort`,
      url: origin,
      env: { AIXAND_SERVER_URL: api },
    },
  ],
})
