import { expect, test, type Page, type WebSocketRoute } from './fixtures'

type Command = { id: string; op: string; args: Record<string, unknown> }
type Connection = { socket: WebSocketRoute; kind: string; closed: boolean; ready: boolean; commands: Command[] }

async function fixture(page: Page, hold = new Set<string>()) {
  let authenticated = true
  let checks = 0
  const failures = new Set<string>()
  const connections: Connection[] = []
  const commands: (Command & { kind: string })[] = []
  const session = { id: 'retained-shell', name: 'development', lifecycle: { state: 'running' } }
  let dropInput = false
  let runningJob = false
  await page.route('**/api/auth/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/logout')) {
      authenticated = false
      return route.fulfill({ json: {} })
    }
    if (path.endsWith('/status')) return route.fulfill({ json: { state: 'configured' } })
    checks++
    return route.fulfill({ status: authenticated ? 200 : 401, json: authenticated
      ? { authenticated: true, csrfToken: 'isolated-recovery', expiresAt: Date.now() + 3600000 }
      : { message: 'Sign in required' } })
  })
  function ready(connection: Connection) {
    if (connection.closed || connection.ready) return
    connection.ready = true
    connection.socket.send(JSON.stringify({ type: 'ready' }))
  }
  function close(connection: Connection) {
    connection.closed = true
    connection.socket.close({ code: 1001, reason: 'Simulated connection loss' })
  }
  await page.routeWebSocket('**/api/**', (socket) => {
    const kind = new URL(socket.url()).pathname.split('/')[2]
    const connection: Connection = { socket, kind, closed: false, ready: false, commands: [] }
    connections.push(connection)
    socket.onClose(() => { connection.closed = true })
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw)) as Command
      connection.commands.push(command)
      commands.push({ ...command, kind })
      if (command.op === 'ack') return
      if (command.op === 'input' && dropInput) { close(connection); return }
      let result: unknown = {}
      if (kind === 'agents') {
        if (command.op === 'catalog') result = { profiles: [], auths: [], capabilities: [], cwd: '/isolated' }
        if (['chat-list', 'project-list', 'sessions', 'models'].includes(command.op)) result = []
        if (command.op === 'project-discovery-list') result = { jobs: [] }
        if (command.op === 'mcp-catalog') result = { servers: [] }
        if (command.op === 'prompts-catalog') result = {
          store: '/isolated/prompts', checked_at: new Date().toISOString(), packs: [], consumers: [], sources: [],
        }
      }
      if (kind === 'carrier') {
        result = []
        if (command.op === 'snapshot') result = { status: { connected: true, agent_configured: true, version: 1 },
          messages: [], counts: {}, total: 0, next_offset: null }
        if (command.op === 'directory') result = { sessions: [], next_after: null }
      }
      if (kind === 'terminals') {
        if (command.op === 'list') result = { items: [session], next_cursor: null, total: 1 }
        if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/isolated', shell: '/bin/sh' } }
        if (command.op === 'attach') result = { stream: command.args.paneId }
      }
      if (kind === 'workflow-jobs') {
        if (command.op === 'health') result = { protocol: 1 }
        if (command.op === 'submit') { runningJob = true; result = { job: { id: 'existing-job', state: 'running' } } }
        if (command.op === 'events') result = { events: [], state: runningJob ? 'running' : 'completed', next_after: 0, has_more: false }
        if (command.op === 'result') result = { id: 'existing-job', state: 'completed', result: {}, error: null }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
    if (failures.has(kind)) { close(connection); return }
    if (!hold.has(kind)) ready(connection)
  })
  return {
    commands, connections, failures,
    checks: () => checks,
    count: (kind: string) => connections.filter((connection) => connection.kind === kind).length,
    active: (kind: string) => connections.filter((connection) => connection.kind === kind && !connection.closed).at(-1)!,
    ready: (kind: string) => connections.filter((connection) => connection.kind === kind).forEach(ready),
    close, dropInput: () => { dropInput = true },
    expire: () => { authenticated = false },
  }
}

async function freeze(page: Page) {
  // Recovery timers are under test; onboarding motion has its own coverage.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install()
  await page.clock.pauseAt(new Date())
}

test('signed-in services connect automatically without startup Connect buttons', async ({ page }) => {
  const f = await fixture(page, new Set(['agents', 'carrier', 'terminals', 'workflow-jobs']))
  await page.goto('/#/chat')
  await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toBeVisible()
  await expect(page.locator('.command-workspace-connection')).toContainText('Connecting…')
  await expect(page.getByRole('button', { name: /^(Connect|Retry connection)$/ })).toHaveCount(0)
  f.ready('agents')
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  await page.goto('/#/carrier')
  await expect(page.getByText('Connecting to your inbox…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Connect|Retry connection)$/ })).toHaveCount(0)
  f.ready('agents')
  f.ready('carrier')
  await expect(page.getByText('Connecting to your inbox…', { exact: true })).toHaveCount(0)
  await page.evaluate(() => { location.hash = '/terminals' })
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connecting…')
  await expect(page.locator('.tw-connect')).toHaveCount(0)
  f.ready('terminals')
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
  await page.evaluate(() => { location.hash = '/workflows/sequential-hello' })
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connecting to Runner…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect to Runner', exact: true })).toHaveCount(0)
  f.ready('workflow-jobs')
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  expect(f.commands.filter((command) => ['submit', 'launch', 'chat-create', 'chat-send', 'input'].includes(command.op))).toEqual([])
})

test('Chat reconnects after a drop while authentication and the draft stay intact', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/chat')
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  await freeze(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep these instructions')
  const before = f.count('agents')
  f.close(f.active('agents'))
  await expect(page.locator('.command-workspace-connection')).toContainText('Reconnecting…')
  await page.clock.runFor(1000)
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  expect(f.count('agents')).toBe(before + 1)
  await expect(input).toHaveValue('Keep these instructions')
  const checksBefore = f.checks()
  await page.evaluate(() => window.dispatchEvent(new Event('aixand-auth-check')))
  await expect.poll(f.checks).toBeGreaterThan(checksBefore)
  await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toBeVisible()
  expect(f.commands.filter((command) => ['chat-create', 'chat-send', 'launch'].includes(command.op))).toEqual([])
})

test('retry delays increase, and focus or network recovery resumes immediately', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  await freeze(page)
  const before = f.count('agents')
  f.failures.add('agents')
  f.close(f.active('agents'))
  await expect(page.locator('.command-workspace-connection')).toContainText('Reconnecting…')
  await expect(page.locator('.command-workspace-connection').getByRole('alert')).toHaveCount(0)
  await page.clock.runFor(999)
  expect(f.count('agents')).toBe(before)
  await page.clock.runFor(1)
  await expect.poll(() => f.count('agents')).toBe(before + 1)
  await page.clock.runFor(1999)
  expect(f.count('agents')).toBe(before + 1)
  await page.clock.runFor(1)
  await expect.poll(() => f.count('agents')).toBe(before + 2)
  f.failures.delete('agents')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  expect(f.count('agents')).toBe(before + 3)
  // A brief ready/close still spends a retry; a stable connection resets it.
  await page.clock.runFor(10_000)
  f.close(f.active('agents'))
  await expect(page.locator('.command-workspace-connection')).toContainText('Reconnecting…')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  expect(f.count('agents')).toBe(before + 4)
  await page.clock.runFor(30_000)
  expect(f.count('agents')).toBe(before + 4)
})

test('three failed browser reconnects stop retrying and offer a manual retry at the top', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  await freeze(page)
  const before = f.count('agents')
  f.failures.add('agents')
  f.close(f.active('agents'))
  const banner = page.getByRole('group', { name: 'Chat connection' })
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await expect(banner.getByRole('alert')).toHaveCount(0)
    await page.clock.runFor(delay)
    await expect.poll(() => f.count('agents')).toBe(before + index + 1)
  }
  await expect(banner.getByRole('alert')).toHaveText('Chat connection unavailable.')
  await expect(page.locator('.command-compose-area .command-workspace-connection')).toHaveCount(0)
  await page.clock.runFor(60000)
  expect(f.count('agents')).toBe(before + 3)
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toHaveCount(0)
  f.failures.delete('agents')
  await banner.getByRole('button', { name: 'Retry connection', exact: true }).click()
  await expect(banner).toHaveCount(0)
  expect(f.count('agents')).toBe(before + 4)
  expect(f.commands.filter(command => ['chat-create', 'chat-send', 'chat-steer', 'chat-queue'].includes(command.op))).toEqual([])
})

test('explicit disconnect and sign-out cancel automatic retries', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/agents')
  await expect(page.getByRole('button', { name: 'Agent Manager connection', exact: true })).toBeVisible()
  await freeze(page)
  await page.getByRole('button', { name: 'Agent Manager connection', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  const stopped = f.count('agents')
  await page.clock.runFor(30_000)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect(f.count('agents')).toBe(stopped)
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Agent Manager connection', exact: true }) })
    .getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.locator('.carrier-connection-footer .carrier-connection-status')).toHaveText('Connected')
  await page.keyboard.press('Escape')
  expect(f.count('agents')).toBe(stopped + 1)
  f.close(f.active('agents'))
  f.close(f.active('carrier'))
  await expect(page.locator('.carrier-offline-banner')).toBeVisible()
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to your Suite', exact: true })).toBeVisible()
  const before = f.connections.length
  await page.clock.runFor(30_000)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  expect(f.connections).toHaveLength(before)
})

test('Carrier and Prompts recover their own connections', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/carrier')
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toHaveText('Connected')
  const carrierBefore = f.count('carrier')
  f.close(f.active('carrier'))
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible()
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toHaveText('Connected')
  expect(f.count('carrier')).toBe(carrierBefore + 1)
  await page.evaluate(() => { location.hash = '/prompts' })
  await expect(page.getByRole('complementary', { name: 'Agent navigation' }).locator('.carrier-connection-status')).toHaveText('Connected')
  await expect.poll(() => f.commands.filter(command => command.op === 'prompts-catalog').length).toBeGreaterThan(0)
  const prompts = f.connections.findLast((connection) => connection.commands.some((command) => command.op === 'prompts-catalog'))!
  const promptsBefore = f.count('agents')
  f.close(prompts)
  await expect.poll(() => f.count('agents')).toBe(promptsBefore + 1)
  await expect(page.getByRole('complementary', { name: 'Agent navigation' }).locator('.carrier-connection-status')).toHaveText('Connected')
  expect(f.count('agents')).toBe(promptsBefore + 1)
})

test('an expired session stops reconnection and returns to sign-in', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  await expect(page.locator('.command-workspace-connection')).toHaveCount(0)
  await freeze(page)
  f.close(f.active('agents'))
  await expect(page.locator('.command-workspace-connection')).toContainText('Reconnecting…')
  f.expire()
  await page.evaluate(() => window.dispatchEvent(new Event('aixand-auth-check')))
  await expect(page.getByRole('heading', { name: 'Sign in to your Suite', exact: true })).toBeVisible()
  const before = f.connections.length
  await page.clock.runFor(30_000)
  expect(f.connections).toHaveLength(before)
})

test('terminal recovery reattaches the existing shell without replaying pending input', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/terminals')
  await page.getByRole('button', { name: 'development running', exact: true }).click()
  const pane = page.getByRole('region', { name: 'Terminal development', exact: true })
  await expect(pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  await freeze(page)
  f.dropInput()
  await pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('x')
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Disconnected')
  const before = f.count('terminals')
  await page.clock.runFor(1000)
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
  await expect(pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  expect(f.count('terminals')).toBe(before + 1)
  expect(f.commands.filter((command) => command.op === 'input')).toHaveLength(1)
  const attaches = f.commands.filter((command) => command.op === 'attach')
  expect(attaches).toHaveLength(2)
  expect(attaches.every((command) => command.args.sessionId === 'retained-shell')).toBe(true)
  expect(f.commands.filter((command) => ['create', 'restart', 'stop'].includes(command.op))).toEqual([])
  await page.evaluate(() => { location.hash = '/home' })
  await expect(page.locator('.terminal-workspace')).toHaveCount(0)
  const left = f.count('terminals')
  await page.clock.runFor(30_000)
  expect(f.count('terminals')).toBe(left)
})

test('Runner reconnects and monitors the same job without submitting it again', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/workflows/sequential-hello')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByText('Job: existing-job', { exact: true })).toBeVisible()
  await freeze(page)
  const before = f.count('workflow-jobs')
  f.close(f.active('workflow-jobs'))
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible()
  await page.clock.runFor(1000)
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  expect(f.count('workflow-jobs')).toBe(before + 1)
  expect(f.commands.filter((command) => command.op === 'submit')).toHaveLength(1)
  expect(f.commands.filter((command) => command.op === 'events').every((command) => command.args.id === 'existing-job')).toBe(true)
})
