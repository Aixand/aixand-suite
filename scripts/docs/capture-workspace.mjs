// Start the loopback Web fixture server as described in documentation.md.
// node scripts/docs/capture-workspace.mjs
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { chromium, expect } = require('@playwright/test')
const output = path.join(root, 'docs/assets/screenshots/workspace')
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const project = { id: projectId, name: 'Studio', path: '/workspace/studio' }
const chat = { id: chatId, projectId, project: 'Studio', cwd: project.path, provider: 'codex', backend: 'native-codex', profile: 'work', auth: null,
  mode: 'chat', title: 'Review the Studio project', model: 'default', permissionMode: 'read-only', status: 'completed', revision: 1,
  createdAt: 1, updatedAt: 2, requests: [], chatCapabilities: { queue: true, steer: true },
  items: [{ id: 'user-1', type: 'userMessage', text: 'Explain this project and suggest one small improvement. Do not change files.' },
    { id: 'command-1', type: 'commandExecution', command: 'rg --files', text: 'README.md\nsrc/App.tsx', status: 'completed', exitCode: 0 },
    { id: 'reply-1', type: 'agentMessage', text: 'Studio is a small web application. Start with README.md, then inspect src/App.tsx.\n\nA useful next step is to add a test for the main page.' }] }
const catalog = { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }], auths: [],
  capabilities: [{ provider: 'codex', installed: true, savedModels: true, budgets: false }],
  backends: [{ id: 'native-codex', provider: 'codex', label: 'Codex', available: true, controls: { model: true, access: true, resources: true, suiteTools: true } }], cwd: project.path }
const sessions = [{ id: 'docs-shell', name: 'studio-shell', cwd: project.path, lifecycle: { state: 'running' } }]
const browser = await chromium.launch()
const captures = []
let agentsSocket
try {
  await mkdir(output, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' })
  page.on('pageerror', error => console.error(error.message))
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'light'))
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const values = { '/api/capabilities': { voice: false, vox: false }, '/api/auth/onboarding/status': { needed: false },
      '/api/auth/installation/status': { available: false, ready: true }, '/api/auth/session': { authenticated: true, csrfToken: 'docs-fixture', expiresAt: 4102444800000 },
      '/api/auth/status': { state: 'configured' } }
    return route.fulfill({ status: pathname in values ? 200 : 503, json: values[pathname] ?? { error: 'Capture blocks live API requests' } })
  })
  await page.routeWebSocket(/\/api\//, socket => {
    const terminal = socket.url().includes('/terminals/'), carrier = socket.url().includes('/carrier/')
    if (!terminal && !carrier) agentsSocket = socket
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw)), args = command.args ?? {}, op = command.op
      if (op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      if (op === 'ack') return
      let result = {}
      if (terminal) {
        if (op === 'list') result = { items: sessions, total: 1, next_cursor: null }
        if (op === 'groups') result = { groups: [], defaults: { cwd: project.path, shell: '/bin/sh' } }
        if (op === 'attach') result = { stream: 'docs-terminal', sessionId: sessions[0].id }
      } else if (carrier) {
        result = op === 'snapshot' ? { status: { connected: true }, messages: [], counts: {}, total: 0, next_offset: null } : []
      } else {
        if (op === 'catalog') result = catalog
        if (op === 'project-list') result = [project]
        if (op === 'chat-list') result = [chat]
        if (op === 'chat-open') result = chat
        if (op === 'sessions') result = { runs: [], runtimeError: null }
        if (['agent-operations', 'project-discovery-list'].includes(op)) result = { operations: [], jobs: [], nextOffset: null }
        if (['models', 'chat-launches', 'workflow-list', 'mcp-jobs'].includes(op)) result = []
        if (op === 'models') result = { schema: 'agent-manager/models-1', status: 'ok', models: [{ id: 'default', name: 'Provider default' }] }
        if (op === 'mcp-catalog') result = { servers: [] }
        if (['mcp-preview', 'mcp-project-status'].includes(op)) result = { states: [], jobs: [], selection: {} }
        if (op === 'resource-catalog') result = { profileDefaultsSupported: false, choices: { instructions: [], skills: [], mcp: [{ label: 'Documentation search', target: { kind: 'managed', publisher_id: 'local', server_id: 'documentation-search' } }] } }
        if (op === 'profile-resources-get') result = { revision: 'docs', instructions: null, skills: [], mcp: [] }
        if (op === 'launch-preview') result = { report: { items: [] } }
        if (op.startsWith('backend-discovery-')) result = { id: 'docs', epoch: 'docs', generation: command.id, sequence: 1, state: 'ready', provider: 'codex', profile: 'work', backend: 'native-codex', sourceRevision: 'docs', settings: [], commands: [], limitations: [], models: [{ id: 'default', name: 'Provider default' }] }
        if (op === 'project-files-list') result = { projectId, path: args.path ?? '', entries: [
          { name: 'src', path: 'src', kind: 'directory', supported: true },
          { name: 'README.md', path: 'README.md', kind: 'file', size: 80, supported: true }], total: 2, nextOffset: null, limited: false }
        if (op === 'project-file-read') result = { projectId, path: args.path, name: 'README.md', kind: 'text', size: 80, modifiedAt: 1, truncated: false, content: '# Studio\n\nA small web application.\n\nRun the project tests before making changes.' }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (terminal && op === 'attach') socket.send(JSON.stringify({ type: 'output', stream: 'docs-terminal', sequence: '1', start: '0', offset: '93',
        data: Buffer.from('$ pwd\r\n/workspace/studio\r\n$ echo aixand-install-ok\r\naixand-install-ok\r\n$ ').toString('base64') }))
    })
  })
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' })
    captures.push(name + '.png')
  }
  await page.goto('http://127.0.0.1:5347/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Explain this project and suggest one small improvement. Do not change files.')
  await capture('new-conversation')
  await page.getByRole('button', { name: / Model$/ }).click()
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  await settings.getByRole('tab', { name: 'Permissions', exact: true }).click()
  await capture('permissions')
  await settings.getByRole('tab', { name: 'Tools', exact: true }).click()
  await page.getByRole('button', { name: 'Edit mcp resources', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Documentation search', exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Documentation search', exact: true }).press('Space')
  await capture('resources')
  await page.keyboard.press('Escape')
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto(`http://127.0.0.1:5347/#/chat/${chatId}`)
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true })).toBeVisible()
  await expect(page.getByText('Studio is a small web application.', { exact: false })).toBeVisible()
  await capture('conversation')
  agentsSocket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'request', request: {
    requestId: 'docs-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run the project tests.' } } } }))
  await expect(page.getByRole('region', { name: 'Agent approval' })).toBeVisible()
  await capture('approval')
  agentsSocket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'requests', requests: [] } }))
  agentsSocket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'status', status: 'completed' } }))
  const showFiles = page.getByRole('button', { name: 'Show project files', exact: true })
  if (await showFiles.isVisible()) await showFiles.click()
  await page.getByRole('button', { name: 'Open file README.md', exact: true }).click()
  await expect(page.getByRole('region', { name: 'File preview' })).toContainText('A small web application.')
  await capture('project-files')
  await page.goto('http://127.0.0.1:5347/#/terminals')
  const others = page.getByRole('button', { name: 'Others', exact: true })
  await expect(others).toBeVisible()
  if (await others.getAttribute('aria-expanded') === 'false') await others.click()
  await page.getByRole('button', { name: 'studio-shell running', exact: true }).click()
  await expect(page.locator('.terminal-live')).toContainText('aixand-install-ok')
  await capture('terminal')
  await page.goto('http://127.0.0.1:5347/#/workflows')
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toBeVisible()
  await expect(page.locator('.react-flow__node').first()).toBeVisible()
  await capture('workflow')
  const hashes = {}
  for (const file of ['apps/web/src/workspace/ChatPage.tsx', 'apps/web/src/chats/Conversation.tsx', 'apps/web/src/terminals/TerminalLibrary.tsx', 'apps/web/src/pages/Workflows.tsx']) hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  await writeFile(path.join(output, 'capture.json'), JSON.stringify({ schema: 1, mode: 'real-ui-with-fixture-data', viewport: { width: 1440, height: 1000 }, theme: 'light', command: 'node scripts/docs/capture-workspace.mjs', screenshots: captures, sourceHashes: hashes }, null, 2) + '\n')
  console.log(`Captured ${captures.length} workspace screenshots with simulated data. No commands or model requests executed.`)
} finally { await browser.close() }
