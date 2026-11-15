import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './client-tests', outputDir: 'test-results/client',
  use: { baseURL: 'http://127.0.0.1:18754', trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 18754 --strictPort', url: 'http://127.0.0.1:18754' },
})
