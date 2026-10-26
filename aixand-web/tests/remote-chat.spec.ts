import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { agentsRequestSchema } from '../../aixand-server/src/agents/protocol'

const deviceId = 'b01a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
const approvalId = 'b02a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
async function fixture(page: Page, failFirst = false, managerOptions?: { ready: boolean; nativeLogin: boolean }, localUnavailable = false) {
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let chat: Record<string, unknown> | null = null
  let failures = failFirst ? 1 : 0
  let event: (value: object) => void = () => {}
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    event = (value) => route.send(JSON.stringify(value))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw)); operations.push(message)
      let result: unknown = {}
      switch (message.op) {
        case 'catalog': result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0,
          readiness: { ready: !localUnavailable } }], auths: [], capabilities: [], cwd: '/suite-host' }; break
        case 'sessions': result = { runs: [], runtimeError: null }; break
        case 'models': case 'mcp-jobs': case 'chat-launches': case 'project-list': result = []; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'mcp-preview': result = { selection: {}, states: [] }; break
        case 'agent-operations': result = { operations: [] }; break
        case 'project-discovery-list': result = { jobs: [], nextOffset: null }; break
        case 'spawn-settings-get': result = { defaultMode: 'read-only', revision: 0 }; break
        case 'chat-list': result = chat ? [chat] : []; break
        case 'chat-open': result = chat; break
        case 'connect-devices': result = { configured: true, apiUrl: 'https://api.netbird.io/api', devices: [
          { id: deviceId, peerId: 'mac', name: 'MacBook', ip: '100.105.89.222', port: 47831, os: 'Darwin', receiveDir: '/Users/owner/Downloads',
            paired: true, online: true, status: 'ready', capabilities: { files: true, codex: true, managerDiscovery: Boolean(managerOptions) } },
          { id: 'legacy', name: 'File PC', status: 'ready', capabilities: { files: true } },
          { id: 'offline', name: 'Offline PC', status: 'offline', capabilities: { files: true, codex: true } },
        ] }; break
        case 'connect-managers-inspect': {
          expect(agentsRequestSchema.safeParse(message).success).toBe(true)
          result = { deviceId, device: 'MacBook', schema: 'aixand-connect/managers-1', packages: { agent: { installed: true, version: '0.1.0' } },
            profiles: [{ profile: 'personal', auth: 'device-login' }], runtime: { ready: managerOptions?.ready }, managedCodex: managerOptions?.ready,
            reason: managerOptions?.ready ? null : 'Start Undercurrent on this device' }
          break
        }
        case 'connect-codex-inspect': result = { installed: true, authenticated: managerOptions?.nativeLogin ?? true, version: 'codex-cli fixture', roots: ['/Users/owner/dev'],
          ...(message.args.cwd ? { cwd: '/Users/owner/dev/project', name: 'project', codex: { installed: true, authenticated: true } } : {}) }; break
        case 'chat-create': {
          expect(agentsRequestSchema.safeParse(message).success).toBe(true)
          chat = { id: message.args.key, deviceId, device: 'MacBook', profile: 'remote', provider: 'codex', auth: null,
            ...(message.args.profileSelection?.mode !== 'direct' ? { remoteProfile: message.args.profileSelection?.profile ?? 'personal', profileSelection: message.args.profileSelection, backendRoute: 'managed', backend: 'native-codex' } : {}),
            model: 'remote-model', cwd: message.args.cwd, project: 'project', projectId: null, mode: 'work', title: 'New conversation',
            accessMode: 'workspace-write', status: 'ready', createdAt: 1, updatedAt: 2, revision: 1, requests: [], items: [] }
          if (failures-- > 0) { route.send(JSON.stringify({ type: 'error', id: message.id, code: 'manager', message: 'Remote creation is unconfirmed' })); return }
          result = chat; break
        }
        case 'chat-send': chat = { ...chat, status: 'running', turnId: 'remote-turn', revision: 2 }; result = chat; break
        case 'chat-answer': {
          // Exercise the real gateway contract: a permissive socket mock hid this regression.
          expect(agentsRequestSchema.safeParse(message).success).toBe(true)
          expect(message.args.requestId).toBe(approvalId)
          chat = { ...chat, status: 'running', requests: [], revision: 7 }; result = { answered: true }
          event({ type: 'chat-event', chatId: chat.id, revision: 7, event: { kind: 'requests', requests: [] } })
          event({ type: 'chat-event', chatId: chat.id, revision: 8, event: { kind: 'status', status: 'running', turnId: 'remote-turn' } })
          break
        }
        case 'chat-interrupt': chat = { ...chat, status: 'interrupted', revision: 5 }; result = { stopping: true };
          event({ type: 'chat-event', chatId: chat.id, revision: 5, event: { kind: 'status', status: 'interrupted', turnId: 'remote-turn' } }); break
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  return { operations, approval: () => {
    const request = { requestId: approvalId, method: 'item/commandExecution/requestApproval',
      params: { threadId: 'remote-thread', turnId: 'remote-turn', command: 'cargo test --locked', reason: 'Download locked dependencies and run tests.' } }
    chat = { ...chat, status: 'waiting', requests: [request], revision: 6 }
    event({ type: 'chat-event', chatId: chat.id, revision: 6, event: { kind: 'request', request } })
  }, delta: () => {
    chat = { ...chat, revision: 3, items: [{ id: 'reply', type: 'agentMessage', text: 'Running on Darwin', turnId: 'remote-turn' }] }
    event({ type: 'chat-event', chatId: chat.id, revision: 3, event: { kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: 'Running on Darwin', turnId: 'remote-turn' } })
  } }
}

async function chooseMac(page: Page, nativeLogin = true) {
  await page.goto('/#/chat')
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  await page.getByRole('button', { name: 'Remote chat', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Start a remote chat', exact: true })
  await dialog.getByRole('button', { name: /Run on device/ }).click()
  await expect(page.getByRole('option', { name: /File PC/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('option', { name: /Offline PC/ })).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('option', { name: 'MacBook', exact: true }).click()
  await expect(dialog.getByText(nativeLogin ? /Signed in on device/ : /Sign in to Codex/)).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Project directory on device', exact: true }).fill('~/dev/project')
  if (await dialog.getByText(/Auto requires Agent Manager/).count()) {
    await dialog.getByRole('button', { name: /Codex configuration on device/ }).click()
    await page.getByRole('option', { name: 'Direct Codex · native login', exact: true }).click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
  }
  return dialog
}

test('start a remote chat, stream output, stop it, and reopen the same location', async ({ page }) => {
  const state = await fixture(page)
  const dialog = await chooseMac(page)
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  const location = page.getByRole('group', { name: 'Remote execution location', exact: true })
  await expect(location).toContainText('MacBook')
  await expect(location).toContainText('/Users/owner/dev/project')
  expect(state.operations.find((row) => row.op === 'chat-create')?.args).toMatchObject({
    deviceId, cwd: '/Users/owner/dev/project', profile: null, mode: 'work', permissionMode: 'workspace-write',
  })
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Run the project tests')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  state.delta()
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true })).toContainText('Running on Darwin')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => state.operations.filter((row) => row.op === 'chat-interrupt').length).toBe(1)
  await page.reload()
  await expect(location).toContainText('/Users/owner/dev/project')
  expect(state.operations.filter((row) => row.op === 'chat-create')).toHaveLength(1)
  expect(state.operations.filter((row) => row.op === 'chat-send')).toHaveLength(1)
})

test('remote chats remain usable when no local providers are ready', async ({ page }) => {
  const state = await fixture(page, false, undefined, true)
  const dialog = await chooseMac(page)
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Codex Provider', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Run this on the remote device')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => state.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  await page.reload()
  await expect(page.getByRole('group', { name: 'Remote execution location', exact: true })).toContainText('MacBook')
  await expect(page.getByRole('button', { name: 'Codex Provider', exact: true })).toBeDisabled()
  expect(state.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
})

test('Approve once preserves a remote approval ID through the gateway contract after reload', async ({ page }) => {
  const state = await fixture(page)
  const dialog = await chooseMac(page)
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Run the project tests')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  state.approval()
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('cargo test --locked', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Approve once', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  expect(state.operations.filter((row) => row.op === 'chat-answer')).toHaveLength(1)
  expect(state.operations.find((row) => row.op === 'chat-answer')?.args).toMatchObject({ requestId: approvalId, decision: 'accept' })
  expect(state.operations.filter((row) => row.op === 'chat-create')).toHaveLength(1)
  expect(state.operations.filter((row) => row.op === 'chat-send')).toHaveLength(1)
})

test('uncertain creation retains its identity and mobile dialog is accessible', async ({ page }) => {
  const state = await fixture(page, true)
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await chooseMac(page)
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('unconfirmed')
  await expect(dialog.getByRole('textbox', { name: 'Project directory on device', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Retry same chat', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('MacBook')
  const creates = state.operations.filter((row) => row.op === 'chat-create')
  expect(creates).toHaveLength(2)
  expect(creates[0].args).toEqual(creates[1].args)
})

test('a remote manager profile uses its own login and retains its selection on retry and reload', async ({ page }) => {
  const state = await fixture(page, true, { ready: true, nativeLogin: false })
  const dialog = await chooseMac(page, false)
  await expect(dialog.getByRole('button', { name: 'Start remote chat', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: /Codex configuration on device/ }).click()
  await page.getByRole('option', { name: 'Agent Manager · personal', exact: true }).click()
  await dialog.getByText('Device manager details', { exact: true }).click()
  await expect(dialog.getByText('Managed Codex available', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('unconfirmed')
  await expect(dialog.getByRole('button', { name: /Codex configuration on device/ })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Retry same chat', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('Agent Manager · personal')
  const creates = state.operations.filter((row) => row.op === 'chat-create')
  expect(creates).toHaveLength(2)
  expect(creates[0].args).toEqual(creates[1].args)
  expect(creates[0].args).toMatchObject({ deviceId, profile: null, profileSelection: { mode: 'specific', profile: 'personal' } })
  await page.reload()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('Agent Manager · personal')
})

test('unavailable managers explain readiness and leave direct Codex available', async ({ page }) => {
  const state = await fixture(page, false, { ready: false, nativeLogin: true })
  const dialog = await chooseMac(page)
  await dialog.getByRole('button', { name: /Codex configuration on device/ }).click()
  await expect(page.getByRole('option', { name: 'Agent Manager · personal' })).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('option', { name: 'Direct Codex · native login', exact: true }).click()
  await dialog.getByText('Device manager details', { exact: true }).click()
  await expect(dialog.getByText('Start Undercurrent on this device', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('MacBook')
  expect(state.operations.find((row) => row.op === 'chat-create')?.args.remoteProfile).toBeUndefined()
})

test('Auto is the default and keeps its launch identity after an uncertain response', async ({ page }) => {
  const state = await fixture(page, true, { ready: true, nativeLogin: false })
  const dialog = await chooseMac(page, false)
  await expect(dialog.getByRole('button', { name: /Codex configuration on device/ })).toContainText('Auto')
  await dialog.getByRole('button', { name: 'Start remote chat', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('unconfirmed')
  await dialog.getByRole('button', { name: 'Retry same chat', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('Auto → personal')
  const creates = state.operations.filter((row) => row.op === 'chat-create')
  expect(creates).toHaveLength(2)
  expect(creates[0].args).toEqual(creates[1].args)
  expect(creates[0].args.profileSelection).toEqual({ mode: 'auto' })
  await page.reload()
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toContainText('Auto → personal')
})
