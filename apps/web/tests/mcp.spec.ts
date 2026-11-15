import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { compileSequence } from '../src/workflows/builder/compile'
import type { CanvasDraft } from '../src/workflows/builder/model'
import AxeBuilder from '@axe-core/playwright'

async function mockManager(page: Page, options: {
  onReconnect?: (respond: (error?: string) => void) => void
  statusError?: string
  unsupported?: boolean
  emptyCatalog?: boolean
  suiteTools?: { status: 'current' | 'pending'; tools: string[] }
} = {}) {
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const project = { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture project', path: '/fixture/project' }
  const profile = { id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0,
    mcp: { schema: 1, servers: options.emptyCatalog ? [] : ['sonar'], revision: 'sha256:' + 'a'.repeat(64) } }
  let resourceDefaults = { revision: profile.mcp.revision, instructions: null, skills: [], mcp: profile.mcp.servers.map(target => ({ target, required: false })) }
  const definitions = (options.emptyCatalog ? [] : ['sonar', 'lore']).map((name) => ({ name, kind: name, command: name, installed: true }))
  const snapshot = { digest: 'sha256:' + 'c'.repeat(64), project: project.path, selection: {},
    states: definitions.map((row) => ({ name: row.name, server_name: 'agent_manager_' + row.name, status: 'prepared', project: project.path })) }
  let jobs: unknown[] = []
  let chat: Record<string, unknown> = {}
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (!command.op) return
      calls.push(command)
      let result: unknown = {}
      if (command.op === 'catalog') result = { profiles: [profile], auths: [], cwd: project.path,
        capabilities: [{ provider: 'codex', installed: true, savedModels: false, budgets: false }] }
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (command.op === 'project-list') result = [project]
      if (command.op === 'models' || command.op === 'chat-list') result = []
      if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: definitions.map(row => ({ label: row.name, target: row.name })) } }
      if (command.op === 'profile-resources-get') result = resourceDefaults
      if (command.op === 'profile-resources-set') {
        expect(command.args.expectedRevision).toBe(resourceDefaults.revision)
        resourceDefaults = { ...command.args.resources, revision: 'sha256:' + 'b'.repeat(64) }
        result = resourceDefaults
      }
      if (command.op === 'launch-preview') result = { report: { items: [] } }
      if (command.op === 'mcp-catalog') result = { servers: definitions, live_updates: false }
      if (command.op === 'mcp-profile-get') result = profile.mcp
      if (command.op === 'mcp-profile-set') {
        expect(command.args.expectedRevision).toBe(profile.mcp.revision)
        profile.mcp = { ...profile.mcp, servers: command.args.servers, revision: 'sha256:' + 'b'.repeat(64) }
        result = profile.mcp
        socket.send(JSON.stringify({ type: 'mcps-changed' }))
      }
      if (command.op === 'mcp-preview' || command.op === 'mcp-project-status') result = snapshot
      if (command.op === 'mcp-jobs') result = jobs
      if (command.op === 'mcp-prepare') {
        result = { id: command.args.key, tools: command.args.tools, project: project.path, status: 'completed', step: 'completed' }
        jobs = [result]
      }
      if (command.op === 'launch' || command.op === 'session-start') result = { run_id: 'fixture-run', session_id: 'fixture-session', mcp: snapshot }
      if (command.op === 'chat-create') {
        chat = { id: command.args.key, provider: 'codex', profile: command.args.profile ?? 'work', auth: null,
          model: null, cwd: project.path, project: '', mode: 'chat', title: 'Fixture conversation', status: 'ready',
          createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [], mcp: { ...snapshot, selection: command.args.mcp } }
        result = chat
      }
      if (command.op === 'chat-send') {
        chat = { ...chat, status: 'completed', title: command.args.text, revision: 2 }
        result = chat
      }
      if (command.op === 'chat-open') result = chat
      if (command.op === 'mcp-chat-status' || command.op === 'mcp-chat-reconnect') {
        result = { capabilities: { reconnect: !options.unsupported, preserve_selection: !options.unsupported, reconnect_scopes: options.unsupported ? [] : ['session'] },
          selection: { selection_digest: snapshot.digest },
          ...(command.op === 'mcp-chat-reconnect' ? { status: 'completed' } : {}),
          servers: [{ name: 'agent_manager_lore', runtimeStatus: 'failed', tools: {}, toolsError: 'MCP connection lost.' }],
          ...(options.suiteTools ? { suiteTools: options.suiteTools } : {}) }
        const respond = (error?: string) => socket.send(JSON.stringify(error ?
          { type: 'error', id: command.id, message: error } : { type: 'result', id: command.id, result }))
        if (command.op === 'mcp-chat-status' && options.statusError) { respond(options.statusError); return }
        if (command.op === 'mcp-chat-reconnect' && options.onReconnect) { options.onReconnect(respond); return }
      }
      if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  return calls
}

async function openChatOptions(page: Page) {
  if (!await page.getByRole('dialog', { name: 'Chat settings', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
}

async function closeChatOptions(page: Page) {
  const options = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  if (await options.isVisible()) await options.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(options).toHaveCount(0)
}

test('chat MCP icon opens a modal and keeps server choices local to the conversation', async ({ page }) => {
  const calls = await mockManager(page)
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Use the selected MCP servers')
  await openChatOptions(page)
  const trigger = page.getByRole('button', { name: 'MCP servers', exact: true })
  await openChatOptions(page)
  await expect(trigger).toBeEnabled()
  await expect(page.locator('.command-stage > details.mcp-settings')).toHaveCount(0)
  await openChatOptions(page)
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'MCP servers', exact: true })
  await expect(dialog).toBeVisible()
  const sonar = dialog.getByRole('checkbox', { name: /^sonar/ })
  const lore = dialog.getByRole('checkbox', { name: /^lore/ })
  const search = dialog.getByRole('searchbox', { name: 'Search MCP servers', exact: true })
  await expect(search).toBeFocused()
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
  await expect(sonar).toBeChecked()
  await expect(lore).not.toBeChecked()
  await search.fill(' LORE ')
  await expect(sonar).toHaveCount(0)
  await lore.focus()
  await page.keyboard.press('Space')
  await search.fill('SONAR')
  await expect(lore).toHaveCount(0)
  await expect(sonar).toBeChecked()
  await sonar.focus()
  await page.keyboard.press('Space')
  await search.fill('missing server')
  await expect(dialog.getByRole('status')).toHaveText('No MCP servers match your search.')
  await search.fill('')
  await expect(lore).toBeChecked()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('data-active', 'true')
  await expect(input).toHaveValue('Use the selected MCP servers')
  await openChatOptions(page)
  await trigger.click()
  await expect(sonar).not.toBeChecked()
  await expect(lore).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await closeChatOptions(page)
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => calls.find((row) => row.op === 'chat-create')?.args.resources).toMatchObject({ mcp: { inherit: false, add: [{ target: 'lore' }] } })
  expect(calls.filter((row) => row.op === 'mcp-profile-set')).toHaveLength(0)
  await openChatOptions(page)
  await openChatOptions(page)
  await expect(trigger).toBeEnabled()
  await openChatOptions(page)
  await trigger.click()
  await expect(dialog.getByRole('group', { name: 'MCP connections', exact: true })).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await closeChatOptions(page)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto Profile', exact: true })).toBeVisible()
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  await openChatOptions(page)
  await trigger.click()
  await expect(sonar).toBeChecked()
  await expect(lore).not.toBeChecked()
})

async function startMcpConversation(page: Page) {
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep this conversation while reconnecting')
  await closeChatOptions(page)
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true })).toBeVisible()
}

test('existing chats reconnect MCPs from the composer and retain the conversation and draft', async ({ page }) => {
  let respond: (error?: string) => void
  const calls = await mockManager(page, { onReconnect: (reply) => { respond = reply },
    suiteTools: { status: 'current', tools: ['list_projects', 'add_project', 'remove_project'] } })
  await startMcpConversation(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Continue after the reconnect')
  await openChatOptions(page)
  const trigger = page.getByRole('button', { name: 'MCP servers', exact: true })
  await openChatOptions(page)
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'MCP servers', exact: true })
  await expect(dialog).toContainText('Connection failed · 0 discovered tools')
  await expect(dialog.getByRole('alert')).toHaveText('MCP connection lost.')
  await dialog.locator('.mcp-suite-tools > summary').click()
  await expect(dialog.locator('.mcp-suite-tools')).toContainText('add_project, remove_project')
  const reconnect = dialog.getByRole('button', { name: 'Reconnect MCPs', exact: true })
  await reconnect.click()
  await expect(dialog.getByRole('button', { name: 'Reconnecting…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Check MCP connections', exact: true })).toBeDisabled()
  await expect.poll(() => calls.filter((row) => row.op === 'mcp-chat-reconnect').length).toBe(1)
  expect(calls.find((row) => row.op === 'mcp-chat-reconnect')?.args).toMatchObject({ chatId: calls.find((row) => row.op === 'chat-create')!.args.key, scope: 'session', expectedSelectionDigest: 'sha256:' + 'c'.repeat(64), operationId: expect.any(String) })
  respond!()
  await expect(dialog.getByRole('status')).toHaveText('MCP reconnect completed. Inspect observed connection states.')
  await expect(reconnect).toBeEnabled()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(trigger).toBeFocused()
  await expect(input).toHaveValue('Continue after the reconnect')
  expect(calls.filter((row) => row.op === 'chat-create')).toHaveLength(1)
  expect(calls.filter((row) => row.op === 'chat-send')).toHaveLength(1)
  expect(calls.filter((row) => row.op === 'mcp-profile-set')).toHaveLength(0)
})

test('reconnect reports a pending Suite tool update without claiming the new tools are active', async ({ page }) => {
  await mockManager(page, { suiteTools: { status: 'pending', tools: ['list_projects', 'add_project', 'remove_project'] } })
  await startMcpConversation(page)
  await openChatOptions(page)
  await page.getByRole('button', { name: 'MCP servers', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'MCP servers', exact: true })
  await expect(dialog.locator('.mcp-suite-tools > summary')).toContainText('Update pending')
  await dialog.getByRole('button', { name: 'Reconnect MCPs', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('MCP reconnect completed. Inspect observed connection states.')
  await expect(dialog).not.toContainText('Suite tools are up to date.')
})

test('MCP reconnect stays disabled when inventory or preservation cannot be verified', async ({ page }) => {
  const calls = await mockManager(page, { statusError: 'Unable to discover MCP tools.', unsupported: true })
  await startMcpConversation(page)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  const information = page.getByRole('dialog', { name: 'Conversation information', exact: true })
  await expect(information.getByRole('alert')).toHaveText('Unable to discover MCP tools.')
  await expect(information.getByRole('button', { name: 'Reconnect MCPs', exact: true })).toBeDisabled()
  await information.getByRole('button', { name: 'Check MCP connections', exact: true }).click()
  expect(calls.filter((row) => row.op === 'mcp-chat-reconnect')).toHaveLength(0)
})

for (const theme of ['light', 'dark']) {
  test(`MCP modal supports Auto selection and is accessible on mobile in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    const calls = await mockManager(page)
    await page.goto('/#/chat')
    await openChatOptions(page)
    const trigger = page.getByRole('button', { name: 'MCP servers', exact: true })
    await openChatOptions(page)
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'MCP servers', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox')).toHaveCount(2)
    await expect(dialog.getByRole('checkbox', { name: 'sonar', exact: true })).not.toBeChecked()
    await expect(dialog.getByRole('checkbox', { name: 'lore', exact: true })).not.toBeChecked()
    await expect(dialog.getByRole('combobox')).toHaveCount(0)
    await dialog.getByRole('searchbox', { name: 'Search MCP servers', exact: true }).fill('lore')
    await dialog.getByRole('checkbox', { name: 'lore', exact: true }).focus()
    await page.keyboard.press('Space')
    await dialog.getByRole('searchbox', { name: 'Search MCP servers', exact: true }).fill('')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/mcp/${theme}-mobile-modal.png`, fullPage: true })
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(trigger).toBeFocused()
    await closeChatOptions(page)
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Start with Lore')
    await closeChatOptions(page)
    await page.getByRole('button', { name: 'Start agent', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => calls.find((row) => row.op === 'chat-create')?.args).toMatchObject({ profile: null, resources: { mcp: { inherit: false, add: [{ target: 'lore' }] } } })
    await openChatOptions(page)
    await expect(trigger).toBeEnabled()
    await openChatOptions(page)
    await trigger.click()
    await expect(dialog.getByRole('button', { name: 'Reconnect MCPs', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Reconnect MCPs', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('status')).toHaveText('MCP reconnect completed. Inspect observed connection states.')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/mcp/${theme}-mobile-reconnect.png`, fullPage: true })
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(trigger).toBeFocused()
  })
}


test('profile MCP defaults persist while conversation opt-out stays local', async ({ page }) => {
  const calls = await mockManager(page)
  await page.goto('/#/agents/profiles?profile=codex%2Fwork')
  await expect(page.getByRole('button', { name: 'Actions for sonar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add tools', exact: true }).click()
  await page.getByRole('button', { name: 'Add lore', exact: true }).click()
  await page.getByRole('button', { name: 'Save skills and tools', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Skills & tools', exact: true })).toBeVisible()
  expect(calls.find(row => row.op === 'profile-resources-set')?.args).toMatchObject({
    provider: 'codex', profile: 'work', expectedRevision: 'sha256:' + 'a'.repeat(64),
    resources: { mcp: [{ target: 'sonar', required: false }, { target: 'lore', required: false }] },
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Actions for lore', exact: true })).toBeVisible()
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  await openChatOptions(page)
  await page.getByRole('dialog', { name: 'Chat settings', exact: true }).getByText('Resources', { exact: true }).click()
  const mcp = page.getByRole('group', { name: 'MCP servers', exact: true })
  await expect(mcp.getByRole('checkbox', { name: 'lore · profile default', exact: true })).toBeChecked()
  await mcp.getByRole('checkbox', { name: 'Include profile defaults', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('dialog', { name: 'Chat settings', exact: true }).locator('.resource-report')).toBeVisible()
  await closeChatOptions(page)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use only this conversation selection')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => calls.filter(row => row.op === 'chat-create').length).toBe(1)
  expect(calls.find(row => row.op === 'chat-create')!.args.resources).toMatchObject({ mcp: { inherit: false } })
  expect(calls.filter(row => row.op === 'profile-resources-set')).toHaveLength(1)
  expect(calls.filter(row => row.op === 'mcp-profile-set')).toHaveLength(0)
})

test('fresh MCP libraries have no bundled servers or project preparation controls', async ({ page }) => {
  const calls = await mockManager(page, { emptyCatalog: true })
  await page.goto('/#/agents/tools')
  await expect(page.getByText('No MCP servers', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'MCP library actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Register publisher definition', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Initialize bundled servers', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'MCP library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Project indexes', exact: true }).click()
  await page.getByRole('button', { name: /^Fixture project/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'No project index servers are configured.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check source freshness', exact: true })).toHaveCount(0)
  await expect(page.getByText('Preparation options', { exact: true })).toHaveCount(0)
  expect(calls.some(row => ['mcp-prepare', 'mcp-managed-bootstrap'].includes(row.op))).toBe(false)
})

test('project preparation uses retained jobs and works without secure-context randomUUID', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(crypto, 'randomUUID', { value: undefined }) })
  const calls = await mockManager(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Tools (MCP)', exact: true }).click()
  await page.getByRole('button', { name: 'MCP library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Project indexes', exact: true }).click()
  await page.getByRole('button', { name: /^Fixture project/ }).click()
  await page.getByRole('button', { name: 'Refresh sonar', exact: true }).click()
  await expect.poll(() => calls.filter((row) => row.op === 'mcp-prepare').length).toBe(1)
  expect(calls.find((row) => row.op === 'mcp-prepare')!.args).toMatchObject({ tools: ['sonar'], refresh: true })
  await page.getByText('Preparation history', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'sonar · completed' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Tools (MCP)', exact: true }).click()
  await page.getByRole('button', { name: 'MCP library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Project indexes', exact: true }).click()
  await page.getByRole('button', { name: /^Fixture project/ }).click()
  await page.getByText('Preparation history', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'sonar · completed' })).toBeVisible()
})

test('workflow MCP selections select the newer contract and legacy calls retain 1.0.0', () => {
  const draft: CanvasDraft = { format: 'aixand.workflow-canvas', version: 1, name: 'MCP workflow', description: '',
    nodes: [{ id: 'spawn', type: 'workflowStep', position: { x: 0, y: 0 }, data: { kind: 'spawn', label: 'Spawn', description: '', prompt: '', agent: '' } },
      { id: 'done', type: 'workflowStep', position: { x: 200, y: 0 }, data: { kind: 'done', label: 'Done', description: '', prompt: '', agent: '' } }],
    edges: [{ id: 'edge', source: 'spawn', target: 'done', sourceHandle: 'out', targetHandle: 'in' }] }
  let steps = compileSequence(draft).workflow.body
  expect(JSON.stringify(steps)).toContain('"version":"1.0.0"')
  draft.nodes[0].data.mcp = { inherit: true, add: ['lore'], exclude: ['sonar'] }
  steps = compileSequence(draft).workflow.body
  expect(JSON.stringify(steps)).toContain('"version":"1.1.0"')
  expect(JSON.stringify(steps)).toContain('"exclude":["sonar"]')
})
