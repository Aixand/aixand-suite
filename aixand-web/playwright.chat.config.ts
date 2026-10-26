import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['chat-commands.spec.ts', 'chat-focus.spec.ts', 'chat-delete.spec.ts', 'background-work.spec.ts', 'chat-cache.spec.ts', 'chat-followups.spec.ts', 'chat-navigation.spec.ts', 'chat-recovery.spec.ts', 'connection-recovery.spec.ts', 'chat-inbox.spec.ts', 'chat-mentions.spec.ts', 'chat-models.spec.ts', 'conversation.spec.ts', 'project-discovery.spec.ts', 'project-files.spec.ts', 'vox-conversations.spec.ts'], outputDir: 'test-results/chat',
  metadata: { mockAuthentication: true }, fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5213', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5213 --strictPort',
    url: 'http://127.0.0.1:5213', env: { AIXAND_SERVER_URL: 'http://127.0.0.1:1' }, reuseExistingServer: false },
})
