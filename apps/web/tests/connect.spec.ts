import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ConnectStatus, Device, Transfer } from '../src/connect/model'

const chatId = 'a01a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
const deviceId = 'b01a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
const transferId = 'c01a1d94-dafd-4c3d-9f93-a1e6eb4c7921'

async function fixture(page: Page, withTransfer = false) {
  let settings: ConnectStatus = { configured: false, apiUrl: 'https://api.netbird.io/api' }
  const devices: Device[] = []
  let transfer: Transfer = { id: transferId, chatId, deviceId, device: 'Windows PC', source: 'dist/app.zip', name: 'app.zip',
    status: 'sending', bytesSent: 1024, size: 4096, destination: null, sha256: null, error: null,
    sourceCallId: 'send-call', sourceTurnId: 'turn', revision: 2, createdAt: 2, updatedAt: 2 }
  const operations: { op: string; args: Record<string, unknown> }[] = []
  const chat = () => ({ id: chatId, profile: 'work', provider: 'codex', auth: null, model: 'model', cwd: '/project', project: 'Suite',
    mode: 'chat', title: 'Send build to Windows', status: 'completed', createdAt: 1, updatedAt: 2, revision: 1, requests: [],
    items: [{ id: 'user', type: 'userMessage', text: 'Copy dist/app.zip to my Windows PC', turnId: 'turn' },
      { id: 'send-call', type: 'dynamicToolCall', text: 'send_file\nAccepted', turnId: 'turn' },
      { id: 'reply', type: 'agentMessage', text: 'The transfer has started.', turnId: 'turn' }],
    transfers: withTransfer ? [transfer] : [] })
  let emit: (value: Transfer) => void = () => {}
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    emit = (value) => route.send(JSON.stringify({ type: 'connect-transfer-updated', transfer: value }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw)); operations.push(message)
      let result: unknown = {}
      switch (message.op) {
        case 'catalog': result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/project' }; break
        case 'sessions': result = { runs: [], runtimeError: null }; break
        case 'models': case 'mcp-jobs': case 'chat-launches': case 'project-list': result = []; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'mcp-preview': result = { selection: {}, states: [] }; break
        case 'agent-operations': result = { operations: [] }; break
        case 'project-discovery-list': result = { jobs: [], nextOffset: null }; break
        case 'spawn-settings-get': result = { defaultMode: 'read-only', revision: 0 }; break
        case 'chat-list': result = withTransfer ? [chat()] : []; break
        case 'chat-open': result = chat(); break
        case 'connect-devices': case 'connect-status': result = { ...settings, devices }; break
        case 'connect-configure': settings = { configured: true, apiUrl: message.args.apiUrl }; result = settings; break
        case 'connect-peers': result = { peers: [{ id: 'peer', name: 'Windows PC', ip: '100.80.1.2', os: 'Windows', connected: true },
          { id: 'offline', name: 'MacBook', ip: '100.80.1.3', os: 'Darwin', connected: false }] }; break
        case 'connect-pair': {
          const device: Device = { id: deviceId, peerId: 'peer', name: message.args.name, ip: '100.80.1.2', port: message.args.port,
            os: 'Windows', receiveDir: 'C:\\Users\\Owner\\Downloads', paired: true, online: true, status: 'ready',
            capabilities: { files: true, codex: false, managerDiscovery: true } }
          devices.push(device); result = device; break
        }
        case 'connect-managers-inspect': result = { schema: 'aixand-connect/managers-1',
          packages: { agent: { installed: true, version: '0.1.0', configured: true } }, profiles: [{ profile: 'personal', auth: null }],
          runtime: { ready: false }, managedCodex: false, reason: 'Managed remote sessions currently require a POSIX device' }; break
        case 'connect-forget': devices.length = 0; result = { removed: true }; break
        case 'connect-cancel': transfer = { ...transfer, status: 'cancelled', error: 'Cancelled', revision: transfer.revision + 1 }; result = transfer; emit(transfer); break
        case 'connect-check': transfer = { ...transfer, status: 'completed', bytesSent: transfer.size, error: null,
          destination: 'C:\\Users\\Owner\\Downloads\\app.zip', sha256: 'a'.repeat(64), revision: transfer.revision + 1 }; result = transfer; emit(transfer); break
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  return { operations, update: (changes: Partial<Transfer>) => { transfer = { ...transfer, ...changes, revision: transfer.revision + 1 }; emit(transfer) },
    stale: () => emit({ ...transfer, revision: 1, status: 'sending' }) }
}

test('connect NetBird, download the companion, pair a device, and forget it', async ({ page }) => {
  const state = await fixture(page)
  await page.goto('/#/settings?section=devices')
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Device actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add device', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Connect NetBird', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'NetBird API token', exact: true }).fill('test-token-' + 'x'.repeat(32))
  await page.getByRole('button', { name: 'Save NetBird connection', exact: true }).click()
  await expect(page.getByText('NetBird connected. Load your devices to pair a companion.')).toBeVisible()
  const dialog = page.getByRole('dialog', { name: 'Add device', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Download companion', exact: true })).toBeHidden()
  await dialog.getByRole('button', { name: 'Companion setup', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Download companion', exact: true })).toBeVisible()
  await page.route('**/api/connect/companion', route => route.fulfill({ contentType: 'application/zip', body: Buffer.from('PK companion fixture') }))
  const pendingDownload = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download companion', exact: true }).click()
  const download = await pendingDownload
  expect(download.suggestedFilename()).toBe('aixand-connect.pyz')
  expect(await download.failure()).toBeNull()
  await dialog.getByRole('button', { name: 'Companion setup', exact: true }).click()
  await page.getByRole('button', { name: 'Load NetBird devices' }).click()
  await page.getByRole('button', { name: /Receiving NetBird device/ }).click()
  await expect(page.getByRole('option', { name: /MacBook/ })).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('option', { name: /Windows PC/ }).click()
  await page.getByRole('textbox', { name: 'One-time pairing code', exact: true }).fill('p'.repeat(43))
  await page.getByRole('button', { name: 'Pair device', exact: true }).click()
  await expect(page.getByText('Ready to receive', { exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Device actions', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Device actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add device', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'One-time pairing code', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Close device setup', exact: true }).click()
  expect(state.operations.find((row) => row.op === 'connect-pair')?.args).toMatchObject({ peerId: 'peer', port: 47831, name: 'Windows PC' })
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(storage).not.toContain('test-token'); expect(storage).not.toContain('p'.repeat(43))
  await page.reload()
  await expect(page.getByText('Ready to receive', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Device details for Windows PC', exact: true }).click()
  await page.getByText('Managers on this device', { exact: true }).click()
  await page.getByRole('button', { name: 'Check managers on Windows PC', exact: true }).click()
  await expect(page.getByText('Agent Manager: Installed · 0.1.0 · configured', { exact: true })).toBeVisible()
  await expect(page.getByText('Managed Codex not ready', { exact: true })).toBeVisible()
  await expect(page.getByText('Device profiles: personal', { exact: true })).toBeVisible()
  expect(state.operations.find((row) => row.op === 'connect-managers-inspect')?.args).toEqual({ deviceId })
  await page.getByRole('button', { name: 'Remove Windows PC', exact: true }).click()
  await page.getByRole('button', { name: 'Remove device', exact: true }).click()
  await expect(page.getByText('No devices paired yet.')).toBeVisible()
})

test('chat transfer progress, verified receipt, stale events, and reload', async ({ page }) => {
  const state = await fixture(page, true)
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'File transfer: app.zip', exact: true })
  await expect(card).toBeVisible()
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', '1024')
  state.update({ status: 'uncertain', error: 'Connection lost. Check delivery before retrying.' })
  await expect(card.getByText('Delivery unconfirmed')).toBeVisible()
  await card.getByRole('button', { name: 'Check delivery', exact: true }).click()
  await expect(card.getByText('Delivered and verified')).toBeVisible()
  await expect(card).toContainText('C:\\Users\\Owner\\Downloads\\app.zip')
  state.stale()
  await expect(card.getByText('Delivered and verified')).toBeVisible()
  await page.reload()
  await expect(card.getByText('Delivered and verified')).toBeVisible()
  expect(state.operations.filter((row) => row.op === 'connect-send')).toHaveLength(0)
})

test('chat cancellation and mobile accessibility', async ({ page }) => {
  const state = await fixture(page, true)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'File transfer: app.zip', exact: true })
  await card.getByRole('button', { name: 'Cancel transfer', exact: true }).click()
  await expect(card.getByText('Cancelled', { exact: true }).first()).toBeVisible()
  expect(state.operations.find((row) => row.op === 'connect-cancel')?.args).toEqual({ chatId, transferId })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.connect-transfer').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})
