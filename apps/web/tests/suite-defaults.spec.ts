import { test, expect, type Page } from './fixtures'

async function fixture(page: Page) {
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const report = { items: [{ id: 'suite-workspace', kind: 'mcp', target: { kind: 'managed', publisher_id: 'aixand-suite', server_id: 'workspace' },
    origin: 'application', application: { id: 'aixand-suite/controller', revision: 'sha256:captured' },
    required: true, status: 'applied', verification: 'checked', delivery: 'native', revision: 'sha256:accepted', reconciliation_required: true }] }
  let chat: Record<string, unknown> = {}
  let upgrades = 0
  await page.routeWebSocket('**/api/carrier/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      const result = command.op === 'snapshot' ? { status: { connected: true, agent_configured: true, providers: ['codex'] }, messages: [], counts: {}, total: 0, next_offset: null } : []
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (!command.op) return
      calls.push(command)
      let result: unknown = []
      if (command.op === 'catalog') result = { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/fixture' }
      if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      if (command.op === 'profile-resources-get') result = { revision: 'sha256:profile', instructions: null, skills: [], mcp: [] }
      if (command.op === 'launch-preview') result = { report: command.args.applicationPreset === 'basic' ? { items: [] } : report }
      if (command.op === 'chat-create') result = chat = { id: command.args.key, provider: 'codex', profile: 'work', cwd: '/fixture', project: '', mode: 'chat',
        title: 'Suite defaults', status: 'ready', createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [],
        applicationPreset: { id: command.args.suiteTools === false ? 'aixand-suite/basic' : 'aixand-suite/controller', revision: 'sha256:captured' },
        resourceSnapshotRef: 'captured-resources', resourceReport: command.args.suiteTools === false ? { items: [] } : report }
      if (command.op === 'chat-send') result = chat = { ...chat, status: 'completed', revision: 2 }
      if (command.op === 'chat-open') result = chat
      if (command.op === 'mcp-chat-status') result = { servers: [], suiteTools: { status: 'current', tools: ['list_projects'] } }
      if (command.op === 'suite-tools-refresh') {
        if (++upgrades === 1) { socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Inspect retained upgrade receipt' })); return }
        result = chat
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  return calls
}

test('Suite defaults survive profile inheritance being disabled and upgrade retries retain their key', async ({ page }) => {
  const calls = await fixture(page)
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const options = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  await options.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await expect(options.getByRole('checkbox', { name: 'Include Suite tools', exact: true })).toBeChecked()
  await options.getByRole('checkbox', { name: 'Inherit profile resources', exact: true }).uncheck()
  await expect(options.getByText('Included by Suite', { exact: false })).toBeVisible()
  await expect(options.getByText('Using the accepted copy.', { exact: false })).toBeVisible()
  await expect.poll(() => calls.filter(row => row.op === 'launch-preview').at(-1)?.args.applicationPreset).toBe('controller')
  await options.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use the defaults')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => calls.find(row => row.op === 'chat-create')?.args.suiteTools).toBe(true)
  expect(calls.find(row => row.op === 'chat-create')?.args.resources).toMatchObject({ inherit_profile: false })
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  await options.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await expect(options.getByRole('region', { name: 'Resource delivery' })).toContainText('Included by Suite')
  await options.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  const info = page.getByRole('dialog', { name: 'Conversation information', exact: true })
  await expect(info.getByText('aixand-suite/controller', { exact: false })).toBeVisible()
  await expect(info.getByText('Native tools delivered.', { exact: true })).toBeVisible()
  await info.getByRole('button', { name: 'Update Suite tools', exact: true }).click()
  await expect(info.getByRole('alert')).toContainText('Inspect retained upgrade receipt')
  await info.getByRole('button', { name: 'Update Suite tools', exact: true }).click()
  await expect.poll(() => calls.filter(row => row.op === 'suite-tools-refresh').length).toBe(2)
  const upgrades = calls.filter(row => row.op === 'suite-tools-refresh')
  expect(upgrades[0].args).toEqual(upgrades[1].args)
})

test('Basic chat explicitly opts out of Suite defaults in preview and creation', async ({ page }) => {
  const calls = await fixture(page)
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const options = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  await options.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await options.getByRole('checkbox', { name: 'Include Suite tools', exact: true }).uncheck()
  await expect.poll(() => calls.filter(row => row.op === 'launch-preview').at(-1)?.args.applicationPreset).toBe('basic')
  await expect(options.getByText('No manager resources selected.', { exact: true })).toBeVisible()
  await options.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use a Basic chat')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => calls.find(row => row.op === 'chat-create')?.args.suiteTools).toBe(false)
})
