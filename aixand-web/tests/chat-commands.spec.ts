import { expect, openChatModelSettings, openChatSettings, test, type Page, type WebSocketRoute } from './fixtures'
import { commandInput, settingValue, type ChatCommand } from '../src/chats/commands'
import { activeFileMention, fileMentions, fileToken, removeFileReference, resolvePromptReferences } from '../src/chats/fileReferences'
import type { ChatSnapshot } from '../src/chats/model'
import type { Backend } from '../src/agents/client'
import AxeBuilder from '@axe-core/playwright'
import { mockHomeOverview } from './home-helpers'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const otherProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const commands: ChatCommand[] = [
  { name: 'model', description: 'Change model', execution: 'setting', configId: 'model' },
  { name: 'fast', description: 'Change speed', execution: 'setting', configId: 'serviceTier' },
  { name: 'reasoning', description: 'Change reasoning effort', execution: 'setting', configId: 'provider-effort' },
  { name: 'compact', description: 'Compact conversation', execution: 'native' },
  { name: 'permissions', description: 'Choose permissions', execution: 'setting', configId: 'permissions' },
  { name: 'plan', description: 'Planning mode', execution: 'setting', configId: 'mode' },
  { name: 'help', description: 'Browse commands', execution: 'client', action: 'help' },
  { name: 'resume', description: 'Open conversation', execution: 'client', action: 'history' },
  { name: 'new', description: 'Start conversation', execution: 'client', action: 'new' },
  { name: 'rename', description: 'Rename conversation', execution: 'native' },
  { name: 'mcp', description: 'Inspect MCP servers', execution: 'native' },
  { name: 'export', description: 'Export conversation', execution: 'suite' },
  { name: 'plugins', description: 'Provider plugins', execution: 'terminal', reason: 'Use the provider terminal.' },
  { name: 'fast-unavailable', description: 'Unavailable speed', execution: 'unsupported', reason: 'The model does not advertise it.' },
  { name: 'provider-check', description: 'Provider check', execution: 'prompt' },
]
async function fixture(page: Page, existing = true, loseOnce?: 'chat-create' | 'chat-config-set' | 'chat-send' | 'chat-command', overrides: Partial<ChatSnapshot> = {}, setup: { backends?: Backend[]; failCreate?: boolean; discoveryDelay?: number; discoveryFail?: boolean; home?: boolean } = {}) {
  if (setup.home) await mockHomeOverview(page)
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let lastDiscovery: Record<string, unknown> = {}
  let socket: WebSocketRoute
  let current: ChatSnapshot = { id: chatId, provider: 'codex', profile: 'work', auth: null, model: 'one',
    title: 'Command test', cwd: '/workspace/studio', project: 'Studio', projectId, mode: 'work',
    createdAt: 1, updatedAt: 1, revision: 1, status: 'ready', items: [], requests: [], accessMode: 'read-only', approvalPolicy: 'on-request',
    commandsState: 'ready', availableCommands: commands, sessionConfig: [
      { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'one', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] },
      { id: 'serviceTier', category: 'model_config', name: 'Speed', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Standard' }, { value: 'fast', name: 'Fast' }] },
      { id: 'provider-effort', category: 'model_config', name: 'Reasoning effort', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Auto' }, { value: 'high', name: 'High' }] },
      { id: 'permissions', category: 'permissions', name: 'Permissions', type: 'select', currentValue: ':read-only', options: [{ value: ':read-only', name: 'Read only' }, { value: ':workspace', name: 'Workspace' }] },
      { id: 'mode', category: 'mode', name: 'Agent mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
      { id: 'verbose', name: 'Verbose output', type: 'boolean', currentValue: false },
    ], ...overrides }
  let created = existing
  await page.routeWebSocket('**/api/carrier/ws', route => {
    route.send(JSON.stringify({ type: 'ready' })); route.onMessage(raw => { const { id } = JSON.parse(String(raw)); route.send(JSON.stringify({ type: 'result', id, result: [] })) })
  })
  await page.routeWebSocket('**/api/agents/ws', route => {
    socket = route; route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const { id, op, args } = JSON.parse(String(raw)); operations.push({ op, args })
      let result: unknown = []
      if (op === 'catalog') result = { profiles: [{ id: `${current.provider}/work`, provider: current.provider, profile: 'work', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace',
        ...(setup.backends ? { backends: setup.backends } : current.backend ? { backends: [{ id: current.backend, provider: current.provider, available: true, label: 'SDK fixture', modelInput: 'text', commandPreview: sdkPreview(current.provider), controls: { model: true, instructions: true, skills: true, mcp: true, suiteTools: true, voice: false, terminal: false } }] } : {}) }
      else if (op === 'project-list') result = [{ id: projectId, name: 'Studio', path: '/workspace/studio' },
        { id: otherProjectId, name: 'Lab', path: '/workspace/lab' }]
      else if (op === 'project-discovery-list') result = { jobs: [], nextOffset: null }
      else if (op === 'sessions') result = { runs: [], runtimeError: null }
      else if (op === 'mcp-catalog') result = { servers: [] }
      else if (op === 'chat-list') result = created ? [current] : []
      else if (op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      else if (op === 'models') result = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]
      else if (op === 'backend-discovery-get' || op === 'backend-discovery-refresh') {
        const catalog = { id: `${args.profile}:${args.backend}:${args.projectId ?? ''}`, epoch: 'fixture-epoch', generation: id, sequence: operations.length,
          provider: args.provider, profile: args.profile, backend: args.backend, sourceRevision: 'fixture-source',
          state: setup.discoveryDelay ? 'running' : setup.discoveryFail ? 'error' : 'ready', discoveredAt: Date.now(),
          models: current.sessionConfig?.find(row => row.category === 'model')?.options?.flatMap(row => 'options' in row ? row.options : [row]).map(row => ({ id: row.value, name: row.name })) ?? [],
          settings: current.sessionConfig ?? [], modelsSource: 'sdk', limitations: [], error: setup.discoveryFail ? 'Discovery is unavailable.' : '',
          commands: [...(current.availableCommands ?? []).filter(row => args.provider !== 'antigravity' || row.name !== 'compact').map(row => ({ ...row, startsConversation: row.execution === 'prompt' })),
            ...(args.provider === 'antigravity' ? [{ name: 'compact', description: 'Compact context', execution: 'unsupported', reason: 'Manual compaction is not available in this SDK.' }] : []),
            { name: 'commands', description: 'Refresh available models and commands', execution: 'client', action: 'connect' }] }
        lastDiscovery = catalog
        result = setup.discoveryDelay || setup.discoveryFail ? { ...catalog, settings: [], models: [], commands: [] } : catalog
        if (setup.discoveryDelay) setTimeout(() => route.send(JSON.stringify({ type: 'backend-discovery-updated', discovery: {
          ...catalog, sequence: catalog.sequence + 1000, state: setup.discoveryFail ? 'error' : 'ready',
        } })), setup.discoveryDelay)
      }
      else if (op === 'chat-create') {
        const initial = args.initialConfig as { id: string; value: string | boolean }[] | undefined
        created = true; current = { ...current, id: args.key, ...(args.backend ? { backend: args.backend } : {}),
          ...(args.model ? { model: args.model } : {}), sessionConfig: current.sessionConfig?.map(option => ({ ...option,
            currentValue: initial?.find(row => row.id === option.id)?.value ?? (option.id === 'model' && args.model ? args.model : option.currentValue) })) }; result = current
        if (setup.failCreate) {
          setup.failCreate = false
          current = { ...current, backendRoute: 'managed', status: 'failed', error: 'Configured ACP adapter executable is unavailable; install it explicitly' }
          route.send(JSON.stringify({ type: 'chat-updated', chat: current }))
          route.send(JSON.stringify({ type: 'error', id, code: 'manager', message: current.error }))
          return
        }
      }
      else if (['chat-open', 'chat-commands', 'chat-send'].includes(op)) result = current
      else if (op === 'chat-config-confirm') {
        current = { ...current, status: 'ready', revision: current.revision + 1, initialConfiguration: { state: 'ready', requested: [] } }
        result = current
      }
      else if (op === 'chat-command') {
        if (current.backend === 'claude-sdk' && args.command === 'compact') {
          current = { ...current, revision: current.revision + 1, status: 'running', commandOutput: undefined }
          result = current
          setTimeout(() => {
            current = { ...current, revision: current.revision + 1, status: 'completed',
              commandOutput: { key: String(args.key), command: 'compact', text: 'SDK compaction completed.', format: 'text' } }
            route.send(JSON.stringify({ type: 'chat-updated', chat: current }))
          }, 150)
        } else {
        current = { ...current, revision: current.revision + 1,
          ...(args.command === 'rename' ? { title: String(args.arguments) } : {}),
          commandOutput: { key: String(args.key), command: String(args.command), text: args.command === 'mcp' ? 'fixture-mcp · connected' :
            args.command === 'export' ? '# Command test\n\nSaved response' : 'Conversation renamed.', format: args.command === 'export' ? 'markdown' : 'text' } }
        result = current
        }
      }
      else if (op === 'chat-config-set') {
        current = { ...current, revision: current.revision + 1, ...(args.configId === 'model' ? { model: args.value } : {}),
          sessionConfig: current.sessionConfig?.map(row => row.id === args.configId ? { ...row, currentValue: args.value } : row) }
        route.send(JSON.stringify({ type: 'chat-updated', chat: current })); result = current
      } else if (op === 'project-files-list') result = { projectId, path: '', entries: [{ name: 'My File.ts', path: 'My File.ts', kind: 'file', supported: true, size: 20, modifiedAt: 1 }], total: 1, nextOffset: null, limited: false }
      else if (op === 'project-file-read') result = { projectId, path: args.path, name: 'My File.ts', kind: 'text', content: 'export const included = true', truncated: false, size: 20, modifiedAt: 1 }
      if (op === loseOnce) {
        loseOnce = undefined
        route.send(JSON.stringify({ type: 'error', id, message: 'Response lost. Retry the same request.', code: 'disconnected', uncertain: true }))
      } else route.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  await page.goto(setup.home ? '/#/home' : existing ? `/#/chat/${chatId}` : '/#/chat')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeVisible()
  await expect.poll(() => operations.some(row => row.op === 'chat-list')).toBe(true)
  return { input, operations, discoveryPatch: (patch: object) => socket.send(JSON.stringify({ type: 'backend-discovery-updated', discovery: {
    ...lastDiscovery, ...patch, sequence: 100000,
  } })), patch: (patch: Partial<ChatSnapshot>) => {
    current = { ...current, ...patch, revision: current.revision + 1 }
    socket.send(JSON.stringify({ type: 'chat-updated', chat: current }))
  }, update: () => {
    current = { ...current, model: 'one', revision: current.revision + 1, sessionConfig: current.sessionConfig?.map(row => row.id === 'model' ? { ...row, currentValue: 'one' } : row) }
    socket.send(JSON.stringify({ type: 'chat-updated', chat: current }))
  } }
}

async function openBackendDetails(page: Page) {
  const settings = await openChatSettings(page)
  await settings.getByText('Backend details', { exact: true }).click()
  return settings.getByRole('group', { name: 'Backend discovery', exact: true })
}

async function waitForDiscovery(page: Page) {
  await expect(await openBackendDetails(page)).toContainText('Discovered at')
  await page.keyboard.press('Escape')
}

function claudeBackends(acpAvailable: boolean, sdkAvailable = true): Backend[] {
  return [
    { id: 'claude-acp', provider: 'claude', label: 'Claude', default: true, available: acpAvailable,
      reason: acpAvailable ? undefined : 'Install or configure claude-agent-acp on this machine.', controls: { mcp: true } },
    { id: 'claude-sdk', provider: 'claude', label: 'Claude SDK', available: sdkAvailable, modelInput: 'text',
      reason: sdkAvailable ? undefined : 'Install agent-manager[claude-sdk] in the agent runtime.', controls: { model: true, mcp: true, instructions: true, skills: true, suiteTools: true } },
  ]
}

test('Home slash settings stay in the draft across navigation and launch once on Send', async ({ page }) => {
  const f = await fixture(page, false, undefined, {}, { home: true })
  await f.input.fill('/')
  await expect(page.getByRole('option', { name: /^\/fast Change speed/ })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'models', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
  await f.input.fill('Keep this direction while I browse')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(f.input).toHaveValue('Keep this direction while I browse')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const creates = f.operations.filter(row => row.op === 'chat-create')
  expect(creates).toHaveLength(1)
  expect(creates[0].args.initialConfig).toContainEqual({ id: 'serviceTier', value: 'fast' })
  const discovered = f.operations.find(row => row.op === 'backend-discovery-get')!
  if (!discovered.args.projectId) expect(creates[0].args.key).toBe(discovered.args.draftId)
})

test('background catalog updates retain the highlighted command and cached choices on error', async ({ page }) => {
  const f = await fixture(page, false)
  await f.input.fill('/')
  const menu = page.getByRole('listbox', { name: 'Commands suggestions' })
  await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await f.input.press('ArrowDown')
  await expect(menu.getByRole('option', { name: /^\/fast Change speed/ })).toHaveAttribute('aria-selected', 'true')
  f.discoveryPatch({ state: 'error', error: 'Refresh temporarily failed.', commands: [
    { name: 'added', description: 'New command', execution: 'client', action: 'help' }, ...commands,
  ] })
  await expect(menu.getByRole('option', { name: /^\/fast Change speed/ })).toHaveAttribute('aria-selected', 'true')
  await expect(menu.getByRole('option', { name: /^\/model Change model/ })).toBeVisible()
  await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Choose Speed' })).toBeVisible()
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
})

test('a failed initial configuration blocks Send until current settings are explicitly accepted', async ({ page }) => {
  const f = await fixture(page, true, undefined, { status: 'failed', initialConfiguration: {
    state: 'failed', requested: [{ id: 'removed', value: 'old' }],
  } })
  await f.input.fill('Keep my first message')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Use current session settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
})

test('Copilot ACP draft model selection is applied as initial session configuration', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'copilot', backend: 'copilot-acp', backendRoute: 'managed' }, {
    backends: [{ id: 'copilot-acp', provider: 'copilot', label: 'Copilot ACP', available: true, default: true,
      commandPreview: commands, controls: { model: false, sessionConfig: true, mcp: true } }],
  })
  await f.input.fill('/model')
  await page.getByRole('option', { name: /^\/model Change model/ }).click()
  await page.getByRole('dialog', { name: 'Choose Model' }).getByRole('button', { name: 'Two', exact: true }).click()
  expect(f.operations.some(row => ['chat-create', 'chat-config-set'].includes(row.op))).toBe(false)
  await f.input.fill('Use the chosen model'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const args = f.operations.find(row => row.op === 'chat-create')!.args
  expect(args.backend).toBe('copilot-acp')
  expect(args.model).toBeUndefined()
  expect(args.initialConfig).toContainEqual({ id: 'model', value: 'two' })
})

test('Home discovers SDK models and applies draft slash settings before creating a conversation', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed', model: null },
    { home: true, backends: claudeBackends(false) })
  await f.input.fill('@model:two')
  await page.getByRole('option', { name: /^Two/ }).click()
  await f.input.fill('/fast on')
  await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two/fast')
  await f.input.fill('/plan on')
  await f.input.press('Enter')
  await expect(page.locator('.command-composer-context')).toContainText('Plan')
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/#\/home$/)
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
  await f.input.fill('Use these settings for this task')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.some(row => row.op === 'chat-send')).toBe(true)
  expect(f.operations.find(row => row.op === 'chat-create')?.args).toMatchObject({ backend: 'claude-sdk', model: 'two',
    initialConfig: expect.arrayContaining([{ id: 'serviceTier', value: 'fast' }, { id: 'mode', value: 'plan' }]) })
})

test('Home resolves project file mentions through the same submission pipeline as Chat', async ({ page }) => {
  const f = await fixture(page, false, undefined, {}, { home: true })
  await f.input.fill('@project:studio')
  await page.getByRole('option', { name: /^Studio / }).click()
  await f.input.fill('Review @file:My')
  await page.getByRole('option', { name: /^My File.ts/ }).click()
  await expect(f.input).toHaveValue('Review @file:"My File.ts" ')
  await expect(page).toHaveURL(/#\/home$/)
  expect(f.operations.some(row => row.op === 'chat-send')).toBe(false)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.find(row => row.op === 'chat-send')?.args.text).toContain('export const included = true')
  expect(f.operations.find(row => row.op === 'project-file-read')?.args).toMatchObject({ projectId, path: 'My File.ts' })
  expect(f.operations.find(row => row.op === 'chat-create')?.args.projectId).toBe(projectId)
})

test('a new Claude draft selects the available SDK when the default ACP adapter is missing', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', model: null, sessionConfig: undefined }, { backends: claudeBackends(false) })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
  await expect(settings.getByText('Install or configure claude-agent-acp on this machine.', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await f.input.fill('Use the available Claude SDK')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args.backend).toBe('claude-sdk')
})

test('backend availability can be refreshed after installing SDKs into the Suite runtime', async ({ page }) => {
  const backends = claudeBackends(false, false)
  await fixture(page, false, undefined, { provider: 'claude', model: null, sessionConfig: undefined }, { backends })
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  backends[1].available = true
  backends[1].reason = undefined
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude Provider', exact: true })).toBeVisible()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
})

test('a failed ACP creation offers a new SDK draft without losing the prompt or replaying the failed launch', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', model: null, sessionConfig: undefined }, { backends: claudeBackends(true), failCreate: true })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('Keep my instructions for Claude')
  await f.input.press('Enter')
  const recover = page.getByRole('button', { name: 'Start new chat with Claude SDK', exact: true })
  await expect(recover).toBeEnabled()
  await recover.click()
  await expect(f.input).toHaveValue('Keep my instructions for Claude')
  await expect(f.input).toBeEditable()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
  await expect(settings.getByRole('button', { name: / Backend$/ })).toBeEnabled()
  await page.keyboard.press('Escape')
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create').length).toBe(2)
  const attempts = f.operations.filter(row => row.op === 'chat-create')
  expect(attempts[0].args.backend).toBe('claude-acp')
  expect(attempts[1].args.backend).toBe('claude-sdk')
  expect(attempts[1].args.key).not.toBe(attempts[0].args.key)
})

test('slash settings share visible controls and provider updates survive reload', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/')
  await page.getByRole('option', { name: '/model Change model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose Model' }).getByRole('button', { name: 'Two', exact: true }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two/fast')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  f.update()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('One')
  await page.reload()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('One/fast')
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(2)
  expect(f.operations.some(row => ['chat-send', 'chat-steer', 'chat-queue', 'chat-create'].includes(row.op))).toBe(false)
})

test('SDK questions use the retained question IDs and answer controls', async ({ page }) => {
  const requestId = 'a'.repeat(32)
  const f = await fixture(page, true, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed', status: 'waiting',
    requests: [{ requestId, method: 'sdk/question', params: { kind: 'user_input', questions: [{ id: '0', header: 'Choice', question: 'Which fixture?', options: [{ label: 'First', description: '' }] }] } }] })
  await page.getByRole('button', { name: 'First', exact: true }).click()
  await page.getByRole('button', { name: 'Send answers', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-answer').map(row => row.args.answers)).toEqual([{ '0': 'First' }])
})

test('SDK approvals preserve the offered option and saved recovery has no terminal action', async ({ page }) => {
  const f = await fixture(page, true, undefined, { provider: 'antigravity', backend: 'antigravity-sdk', backendRoute: 'managed', status: 'waiting',
    backendCapabilities: { operations: { restore_session: { supported: true } } },
    requests: [{ requestId: 'b'.repeat(32), method: 'server-manager/request', params: { kind: 'permission', message: 'Allow fixture tool?', choices: [{ optionId: 'deny_once', name: 'Deny' }] } }] })
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-answer').map(row => row.args.response)).toEqual([{ outcome: 'selected', option_id: 'deny_once' }])
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  f.patch({ status: 'offline', requests: [] })
  await expect(page.getByRole('group', { name: 'Chat connection' })).toContainText('Attempt 1 of 3')
  const before = f.operations.filter(row => row.op === 'chat-open').length
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await page.clock.runFor(delay)
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-open').length).toBe(before + index + 1)
  }
  expect(f.operations.some(row => row.op === 'chat-backend-resume')).toBe(false)
  await expect(page.getByRole('button', { name: 'Resume saved session', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in terminal', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume saved session', exact: true }).click()
  await expect.poll(() => f.operations.some(row => row.op === 'chat-backend-resume')).toBe(true)
})

const sdkCommands: ChatCommand[] = [
  { name: 'help', description: 'Browse commands', execution: 'client', action: 'help' },
  { name: 'clear', description: 'Start a new conversation', execution: 'client', action: 'new' },
  { name: 'context', description: 'Inspect SDK context', execution: 'native', requiresIdle: false },
  { name: 'compact', description: 'Compact conversation context', execution: 'native', requiresIdle: true, acceptsArguments: true },
  { name: 'plan', description: 'Switch SDK planning mode', execution: 'setting', configId: 'mode', requiresIdle: true },
  { name: 'permissions', description: 'Choose SDK tool approvals', execution: 'setting', configId: 'permission_mode', requiresIdle: true },
]
const sdkConfig = [
  { id: 'mode', category: 'mode', name: 'Agent mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  { id: 'permission_mode', category: 'permissions', name: 'Tool approvals', type: 'select', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask for approval' }, { value: 'deny', name: 'Deny approval prompts' }] },
]

function sdkPreview(provider: string): ChatCommand[] {
  return [
    ...sdkCommands.filter(row => row.name !== 'compact'),
    ...(provider === 'antigravity' ? [{ name: 'compact', description: 'Compact context', execution: 'unsupported' as const, reason: 'Manual compaction is not available in this SDK.' }] : []),
    { name: 'commands', description: 'Connect to load provider and project commands', execution: 'client', action: 'connect' },
  ]
}

test('SDK slash browsing and explicit discovery refresh leave the conversation as a draft', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: sdkCommands, sessionConfig: sdkConfig })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('/')
  await expect(page.getByRole('option', { name: /^\/context / })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'chat-commands', 'chat-send'].includes(row.op))).toBe(false)
  await page.getByRole('option', { name: /^\/commands / }).click()
  await expect(page.getByRole('option', { name: /^\/compact / })).toBeVisible()
  await expect.poll(() => f.operations.some(row => row.op === 'backend-discovery-refresh')).toBe(true)
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(0)
  expect(f.operations.some(row => row.op === 'chat-send')).toBe(false)
  await f.input.fill('/compact keep the goal'); await f.input.press('Enter')
  await expect(page.getByText('Start a conversation before using this command.', { exact: true })).toBeVisible()
  expect(f.operations.filter(row => row.op === 'chat-command')).toHaveLength(0)
})

test('SDK draft help works without starting a provider session', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed' })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('/help'); await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Available commands', exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'chat-commands', 'chat-send'].includes(row.op))).toBe(false)
})

test('SDK draft setting selection applies on first send without creating an empty conversation', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: sdkCommands, sessionConfig: sdkConfig })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('/')
  await page.getByRole('option', { name: /^\/plan / }).click()
  await page.getByRole('dialog', { name: 'Choose Agent mode' }).getByRole('button', { name: 'Plan', exact: true }).click()
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
  await f.input.fill('Start with my chosen settings'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args.initialConfig).toEqual([{ id: 'mode', value: 'plan' }])
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
})

test('SDK draft shortcuts use discovery metadata without creating a conversation', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: [], sessionConfig: [] }, { discoveryDelay: 1000 })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('/')
  await page.getByRole('option', { name: /^\/plan / }).click()
  await expect(page.getByText('This setting is not advertised. Refresh discovery.', { exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-command', 'chat-send'].includes(row.op))).toBe(false)
})

test('SDK discovery leaves the draft editable and selections survive page navigation', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: [...sdkCommands, { name: 'model', description: 'Choose a model', execution: 'setting', configId: 'model' }],
    sessionConfig: [...sdkConfig, { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: '', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] }] }, { discoveryDelay: 800 })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await expect(f.input).toBeEditable()
  await f.input.fill('Keep my draft and settings')
  await waitForDiscovery(page)
  await page.getByRole('button', { name: / Model$/ }).click()
  await page.getByRole('option', { name: /^Two(?:\s|$)/ }).click()
  await page.getByRole('button', { name: / Agent mode$/ }).click()
  await page.getByRole('option', { name: 'Plan', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  expect(f.operations.filter(row => row.op === 'backend-discovery-get').length).toBeGreaterThanOrEqual(1)
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
  await page.evaluate(() => { location.hash = '/agents' })
  await expect(page).toHaveURL(/#\/agents(?:\/sessions)?$/)
  await page.evaluate(() => { location.hash = '/chat' })
  await expect(f.input).toHaveValue('Keep my draft and settings')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  await expect(page.getByLabel('Conversation context')).toContainText('Plan')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const args = f.operations.find(row => row.op === 'chat-create')!.args
  expect(args.model).toBe('two')
  expect(args.initialConfig).toContainEqual({ id: 'mode', value: 'plan' })
})

test('failed SDK discovery stays in settings and preserves the Home draft when refreshed', async ({ page }) => {
  const setup = { discoveryFail: true, home: true }
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed' }, setup)
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await expect(page.getByText('Discovery is unavailable.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh discovery', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill('my-custom-model')
  await f.input.fill('Keep this draft')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  const discovery = await openBackendDetails(page)
  await expect(discovery).toContainText('Discovery is unavailable.')
  setup.discoveryFail = false
  await discovery.getByRole('button', { name: 'Refresh discovery', exact: true }).click()
  await expect(discovery).toContainText('Discovered at')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('my-custom-model')
  await expect(f.input).toHaveValue('Keep this draft')
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
})

test('SDK prompt commands create a conversation only when submitted', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed' })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await waitForDiscovery(page)
  await f.input.fill('/provider-check inspect the draft')
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-command').map(row => [row.args.command, row.args.arguments])).toEqual([['provider-check', 'inspect the draft']])
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  expect(f.operations.some(row => row.op === 'chat-send')).toBe(false)
})

test('SDK inline planning creates once with plan selected before its first message', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: sdkCommands, sessionConfig: sdkConfig })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await waitForDiscovery(page)
  await f.input.fill('/plan explore this change'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').map(row => row.args.text)).toEqual(['explore this change'])
  expect(f.operations.find(row => row.op === 'chat-create')?.args.initialConfig).toContainEqual({ id: 'mode', value: 'plan' })
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
})

test('Antigravity draft unsupported commands explain availability without starting a session', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'antigravity', backend: 'antigravity-sdk', backendRoute: 'managed' })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Antigravity(?:\s|$)/ }).click()
  await f.input.fill('/compact keep the goal'); await f.input.press('Enter')
  await expect(page.getByText('Manual compaction is not available in this SDK.', { exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'chat-command', 'chat-send'].includes(row.op))).toBe(false)
})

for (const provider of ['codex', 'claude', 'antigravity'] as const) {
  test(`project changes retain the ${provider} profile, backend and acknowledged model`, async ({ page }) => {
    const backend = provider === 'codex' ? undefined : `${provider}-sdk`
    const f = await fixture(page, true, undefined, { provider, backend, backendRoute: backend ? 'managed' : undefined, model: 'two',
      sessionConfig: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'two', options: [{ value: 'two', name: 'Two' }] }] })
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
    const settings = await openChatSettings(page)
    await settings.getByRole('button', { name: / Project$/ }).click()
    await page.getByRole('option', { name: /^Lab(?:\s|$)/ }).click()
    await expect(page).toHaveURL(/#\/chat$/)
    await expect(page.getByRole('button', { name: / Provider$/ })).toContainText(provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Antigravity')
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
    await f.input.fill('Continue in the new project'); await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-create').length).toBe(1)
    const args = f.operations.find(row => row.op === 'chat-create')!.args
    expect(args.provider).toBe(provider)
    expect(args.profile).toBe('work')
    expect(args.backend).toBe(backend)
    expect(args.model).toBe('two')
    expect(args.projectId).toBe(otherProjectId)
  })
}

for (const provider of ['claude', 'antigravity'] as const) {
  test(`an unsent ${provider} draft retains its model through project changes without connecting`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { provider, backend: `${provider}-sdk`, backendRoute: 'managed' })
    await page.getByRole('button', { name: / Provider$/ }).click()
    await page.getByRole('option', { name: new RegExp(`^${provider === 'claude' ? 'Claude' : 'Antigravity'}(?:\\s|$)`) }).click()
    await page.getByRole('button', { name: / Model$/ }).click()
    await page.getByRole('textbox', { name: 'Custom model', exact: true }).fill('chosen-sdk-model')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    for (const project of ['Studio', 'Lab', 'No project']) {
      const settings = await openChatSettings(page)
      await settings.getByRole('button', { name: / Project$/ }).click()
      await page.getByRole('option', { name: new RegExp(`^${project}(?:\\s|$)`) }).click()
      await expect(page.getByRole('button', { name: / Model$/ })).toContainText('chosen-sdk-model')
      await f.input.fill('/')
      await expect(page.getByRole('option', { name: /^\/help / })).toBeVisible()
      await f.input.press('Escape')
    }
    expect(f.operations.some(row => ['chat-create', 'chat-commands', 'chat-send'].includes(row.op))).toBe(false)
    await f.input.fill('Use my selected model'); await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-create').length).toBe(1)
    const args = f.operations.find(row => row.op === 'chat-create')!.args
    expect(args.provider).toBe(provider)
    expect(args.backend).toBe(`${provider}-sdk`)
    expect(args.model).toBe('chosen-sdk-model')
    expect(args.projectId).toBeUndefined()
  })
}

test('SDK plan and permission shortcuts use confirmed configuration operations', async ({ page }) => {
  const f = await fixture(page, true, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: sdkCommands, sessionConfig: sdkConfig })
  await f.input.fill('/plan on'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([['mode', 'plan']])
  await expect(f.input).toHaveValue('')
  await f.input.fill('/permissions deny'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([['mode', 'plan'], ['permission_mode', 'deny']])
  expect(f.operations.some(row => row.op === 'chat-send')).toBe(false)
})

test('Antigravity slash commands explain unsupported controls without sending a prompt', async ({ page }) => {
  const f = await fixture(page, true, undefined, { provider: 'antigravity', backend: 'antigravity-sdk', backendRoute: 'managed',
    availableCommands: [{ name: 'compact', description: 'Compact context', execution: 'unsupported', reason: 'Manual compaction is not available in this SDK.' }], sessionConfig: [sdkConfig[1]] })
  await f.input.fill('/compact keep the goal'); await f.input.press('Enter')
  await expect(page.getByText('Manual compaction is not available in this SDK.', { exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-command', 'chat-send'].includes(row.op))).toBe(false)
})

for (const width of [320, 390, 1440]) {
  test(`model, speed, effort and mode share one panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const f = await fixture(page)
    const composer = page.locator('.command-composer')
    await expect(composer.getByRole('button')).toHaveCount(6)
    await expect(composer.getByRole('button', { name: 'Chat settings', exact: true })).toHaveText('')
    for (const label of ['Provider', 'Profile', 'Model'])
      await expect(composer.getByRole('button', { name: new RegExp(` ${label}$`) })).toBeInViewport()
    await expect(composer.getByRole('button', { name: /Speed|effort|Permissions|Agent mode|Verbose/ })).toHaveCount(0)

    const settings = await openChatSettings(page)
    await expect(settings.getByRole('region', { name: 'Permissions & policy' })).toContainText('Read-only')
    await expect(settings.getByRole('region', { name: 'Permissions & policy' })).toContainText('On request')
    await expect(settings.getByRole('region', { name: 'Advanced', exact: true }).getByRole('button', { name: 'Verbose output: Off' })).toBeVisible()
    await expect(settings.getByRole('button', { name: /Speed|Reasoning effort|Agent mode/ })).toHaveCount(0)
    await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()

    const modelSettings = await openChatModelSettings(page)
    await modelSettings.getByRole('button', { name: / Reasoning effort$/ }).click()
    await page.getByRole('option', { name: 'High', exact: true }).click()
    await expect(modelSettings.getByRole('button', { name: / Reasoning effort$/ })).toContainText('High')
    await modelSettings.getByRole('button', { name: / Speed$/ }).click()
    await page.getByRole('option', { name: 'Fast', exact: true }).click()
    await expect(modelSettings.getByRole('button', { name: / Speed$/ })).toContainText('Fast')
    await modelSettings.getByRole('button', { name: / Agent mode$/ }).click()
    await page.getByRole('option', { name: 'Plan', exact: true }).click()
    await expect(modelSettings.getByRole('button', { name: / Agent mode$/ })).toContainText('Plan')
    await modelSettings.getByRole('option', { name: 'Two', exact: true }).click()
    await expect(modelSettings.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
    if (width === 390) expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-composer/${width}-model-settings.png` })
    await modelSettings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(composer.getByRole('button', { name: / Model$/ })).toContainText('Two/fast · High')
    await expect(composer.getByRole('button', { name: / Model$/ })).toBeFocused()
    await expect(f.input).toHaveValue('')
    await expect(page.getByLabel('Conversation context')).toContainText('Plan')
    await expect(composer.getByRole('button')).toHaveCount(6)
    expect(await composer.locator('.command-model-name').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/chat-composer/${width}-summary.png` })
    expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([
      ['provider-effort', 'high'], ['serviceTier', 'fast'], ['mode', 'plan'], ['model', 'two'],
    ])
  })
}

test('model choices support keyboard selection and closing preserves the draft', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Keep my instructions')
  const panel = await openChatModelSettings(page)
  const first = panel.getByRole('option', { name: 'One', exact: true })
  await first.focus()
  await first.press('ArrowDown')
  await panel.getByRole('option', { name: 'Two', exact: true }).press('Enter')
  await expect(panel.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('status')).toHaveText('Session settings updated.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Two Model', exact: true })).toBeFocused()
  await expect(f.input).toHaveValue('Keep my instructions')
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => row.args.value)).toEqual(['two'])
})

test('opening slash refreshes metadata without creating a session before Send', async ({ page }) => {
  const f = await fixture(page, false)
  await f.input.fill('/')
  await expect(page.getByRole('option', { name: /^\/compact Compact conversation/ })).toBeVisible()
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(0)
  expect(f.operations.some(row => row.op === 'chat-send')).toBe(false)
  await f.input.press('Escape'); await f.input.fill('First real message'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  expect(f.operations.find(row => row.op === 'chat-send')?.args.text).toBe('First real message')
})

test('lost first launch retries its frozen key and configuration only after Send', async ({ page }) => {
  const f = await fixture(page, false, 'chat-create')
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
  await f.input.fill('First message'); await f.input.press('Enter')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const creates = f.operations.filter(row => row.op === 'chat-create')
  expect(creates).toHaveLength(2)
  expect(creates[0].args).toEqual(creates[1].args)
})

test('lost fast response retries the same explicit value instead of toggling again', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await f.input.fill('/fast'); await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('One/fast')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(f.input).toHaveValue('')
  const settings = f.operations.filter(row => row.op === 'chat-config-set')
  expect(settings).toHaveLength(2)
  expect(settings[0].args).toEqual(settings[1].args)
  expect(settings[1].args.value).toBe('fast')
})

test('picker changes preserve the draft and can retry with an empty draft', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await (await openChatModelSettings(page)).getByRole('button', { name: / Speed$/ }).click()
  await page.getByRole('option', { name: 'Fast', exact: true }).click()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').length).toBe(2)
  await f.input.fill('Keep my draft')
  const modelSettings = await openChatModelSettings(page)
  await modelSettings.getByRole('button', { name: / Speed$/ }).click()
  await page.getByRole('option', { name: 'Standard', exact: true }).click()
  await expect(modelSettings.getByRole('button', { name: / Speed$/ })).toContainText('Standard')
  await modelSettings.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toHaveText('One')
  await expect(f.input).toHaveValue('Keep my draft')
})

test('confirmed provider settings allow continuing after an uncertain response', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await page.getByRole('button', { name: 'Continue with confirmed settings', exact: true }).click()
  await expect(f.input).toBeEditable()
  await expect(f.input).toHaveValue('')
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(1)
})

test('explicit quoted file references use project files and include their content', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Explain @file:')
  await page.getByRole('option', { name: /My File.ts/ }).click()
  await expect(f.input).toHaveValue('Explain @file:"My File.ts" ')
  await expect(page.getByRole('group', { name: 'Project file references' })).toContainText('My File.ts')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.some(row => row.op === 'chat-send')).toBe(true)
  expect(f.operations.find(row => row.op === 'chat-send')?.args.text).toContain('export const included = true')
})

test('file content stays frozen when a send response is lost', async ({ page }) => {
  const f = await fixture(page, true, 'chat-send')
  await f.input.fill('Explain @file:')
  await page.getByRole('option', { name: /My File.ts/ }).click()
  await f.input.press('Enter')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(f.input).toHaveValue('')
  const sends = f.operations.filter(row => row.op === 'chat-send')
  expect(sends).toHaveLength(2)
  expect(sends[0].args).toEqual(sends[1].args)
  expect(f.operations.filter(row => row.op === 'project-file-read')).toHaveLength(1)
})

test('help exposes web, provider, terminal and unavailable commands', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/help'); await f.input.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Available commands' })
  await expect(dialog).toContainText('/permissions')
  await expect(dialog).toContainText('Opens the same conversation in Terminal')
  await expect(dialog.getByRole('button', { name: '/fast-unavailable', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '/plugins', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '/plugins · Terminal' })).toContainText('/plugins')
  await expect(page.getByRole('button', { name: 'Continue in Terminal', exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('unknown native custom commands preserve their complete terminal input', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/custom-command audit --format verbose'); await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: '/custom-command · Terminal' })).toContainText('/custom-command audit --format verbose')
  await page.getByRole('dialog', { name: '/custom-command · Terminal' }).getByRole('button', { name: 'Close' }).click()
  await f.input.fill('/custom-command'); await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: '/custom-command · Terminal' })).toBeVisible()
  expect(f.operations.some(row => ['chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('permission picker updates confirmed state and plan inline prompts use ordered receipts', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/permissions'); await f.input.press('Enter')
  await page.getByRole('dialog', { name: 'Choose Permissions' }).getByRole('button', { name: 'Workspace', exact: true }).click()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Permissions$/ })).toContainText('Workspace')
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await f.input.fill('/plan Explain the migration'); await f.input.press('Enter')
  await expect(page.getByLabel('Conversation context')).toContainText('Plan')
  await expect.poll(() => f.operations.some(row => row.op === 'chat-send')).toBe(true)
  const writes = f.operations.filter(row => ['chat-config-set', 'chat-send'].includes(row.op))
  expect(writes.map(row => row.op)).toEqual(['chat-config-set', 'chat-config-set', 'chat-send'])
  expect(writes[1].args.value).toBe('plan')
  expect(writes[2].args.text).toBe('Explain the migration')
})

test('a lost inline plan send retries its message without repeating the settings change', async ({ page }) => {
  const f = await fixture(page, true, 'chat-send')
  await f.input.fill('/plan Explain the migration'); await f.input.press('Enter')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(f.input).toHaveValue('')
  const sends = f.operations.filter(row => row.op === 'chat-send')
  expect(sends).toHaveLength(2)
  expect(sends[0].args).toEqual(sends[1].args)
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(1)
})

test('provider prompt commands resolve file references once across uncertain retries', async ({ page }) => {
  const f = await fixture(page, true, 'chat-command')
  await f.input.fill('/provider-check @file:')
  await page.getByRole('option', { name: /My File.ts/ }).click()
  await f.input.press('Enter')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(f.input).toHaveValue('')
  const sent = f.operations.filter(row => row.op === 'chat-command')
  expect(sent).toHaveLength(2)
  expect(sent[0].args).toEqual(sent[1].args)
  expect(sent[0].args.arguments).toContain('export const included = true')
  expect(f.operations.filter(row => row.op === 'project-file-read')).toHaveLength(1)
})

test('provider inspections open readable results and rename uses a form', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/mcp'); await f.input.press('Enter')
  const mcp = page.getByRole('dialog', { name: '/mcp', exact: true })
  await expect(mcp).toContainText('fixture-mcp · connected')
  await mcp.getByRole('button', { name: 'Close' }).click()
  await f.input.fill('/rename'); await f.input.press('Enter')
  const rename = page.getByRole('dialog', { name: '/rename', exact: true })
  await rename.getByRole('textbox', { name: 'Conversation name' }).fill('Release prep')
  await rename.getByRole('button', { name: 'Run /rename', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Release prep', exact: true })).toBeVisible()
  expect(f.operations.filter(row => row.op === 'chat-command').map(row => row.args.command)).toEqual(['mcp', 'rename'])
})

test('export and history commands use web dialogs without inference', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/export'); await f.input.press('Enter')
  const dialog = page.getByRole('dialog', { name: '/export', exact: true })
  await expect(dialog).toContainText('Saved response')
  await expect(dialog.getByRole('button', { name: 'Download Markdown', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await f.input.fill('/resume'); await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Choose a conversation' })).toContainText('Command test')
  expect(f.operations.some(row => ['chat-send', 'chat-steer', 'chat-queue'].includes(row.op))).toBe(false)
})

test('parsers distinguish commands, paths, code and selected file references', async () => {
  expect(commandInput('/model/provider/model', commands)).toBeNull()
  expect(commandInput('/model two', commands)?.arguments).toBe('two')
  expect(commandInput('/model provider/model', commands)?.arguments).toBe('provider/model')
  expect(commandInput('/model\ttwo', commands)?.arguments).toBe('two')
  expect(fileMentions('`@file:one.ts`')).toEqual([])
  expect(activeFileMention('See @file:"My File.ts"', 16)?.token).toBe('@file:"My File.ts"')
  expect(fileToken('My File.ts')).toBe('@file:"My File.ts"')
  expect(removeFileReference('See @file:one.ts and `@file:one.ts`', '@file:one.ts')).toBe('See  and `@file:one.ts`')
  const request = async <T,>() => ({ kind: 'text', content: 'content', truncated: false } as T)
  await expect(resolvePromptReferences('See @file:one.ts', [], [], projectId, request, request)).rejects.toThrow('Choose a file')
  await expect(resolvePromptReferences('See @file:one.ts', [], [{ token: '@file:one.ts', projectId: 'other', path: 'one.ts' }], projectId, request, request)).rejects.toThrow('different project')
  expect(settingValue(commands[1], '', { id: 'speed', name: 'Speed', type: 'select', currentValue: 'fast', options: [{ value: 'default', name: 'Standard' }, { value: 'fast', name: 'Fast' }] })).toBe('default')
})

test('bare and explicit model mentions update an existing session while preserving the draft', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Keep this draft @two')
  await page.getByRole('option', { name: /^Model · Two / }).click()
  await expect(f.input).toHaveValue('Keep this draft ')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  await f.input.fill('Keep this draft @model:one')
  await page.getByRole('option', { name: 'One', exact: true }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('One')
  await expect(f.input).toHaveValue('Keep this draft ')
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => row.args.value)).toEqual(['two', 'one'])
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
})

test('relative file shorthand attaches quoted file paths and sends their complete content', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Explain @.')
  await page.getByRole('option', { name: /^My File.ts/ }).click()
  await expect(f.input).toHaveValue('Explain @file:"My File.ts" ')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.find(row => row.op === 'chat-send')?.args.text).toContain('export const included = true')
})

test('effort, speed and mode mentions set advertised values and update the model panel', async ({ page }) => {
  const f = await fixture(page)
  const choices = [
    ['@effort:high', 'High', 'provider-effort', 'high'],
    ['@reasoning:auto', 'Auto', 'provider-effort', 'default'],
    ['@thinking:high', 'High', 'provider-effort', 'high'],
    ['@speed:fast', 'Fast', 'serviceTier', 'fast'],
    ['@fast:off', 'Standard', 'serviceTier', 'default'],
    ['@speed:normal', 'Standard', 'serviceTier', 'default'],
    ['@mode:plan', 'Plan', 'mode', 'plan'],
  ]
  for (const [token, label, configId, value] of choices) {
    await f.input.fill(`Keep this draft ${token}`)
    await page.getByRole('option', { name: new RegExp(`^${label} `) }).click()
    await expect(f.input).toHaveValue('Keep this draft ')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').at(-1)?.args).toMatchObject({ configId, value })
  }
  const panel = await openChatModelSettings(page)
  await expect(panel.getByRole('button', { name: / Reasoning effort$/ })).toContainText('High')
  await expect(panel.getByRole('button', { name: / Speed$/ })).toContainText('Standard')
  await expect(panel.getByRole('button', { name: / Agent mode$/ })).toContainText('Plan')
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(choices.length)
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('bare effort and speed values are searchable without switching models', async ({ page }) => {
  const f = await fixture(page)
  for (const [query, result, configId, value] of [
    ['high', 'Effort · High', 'provider-effort', 'high'],
    ['fast', 'Speed · Fast', 'serviceTier', 'fast'],
    ['normal', 'Speed · Standard', 'serviceTier', 'default'],
    ['plan', 'Mode · Plan', 'mode', 'plan'],
  ]) {
    await f.input.fill(`Keep @${query}`)
    const options = page.getByRole('listbox', { name: 'Chat mention suggestions' }).getByRole('option')
    await expect(options.first()).toHaveText(new RegExp(`^${result}`))
    await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').at(-1)?.args).toMatchObject({ configId, value })
    await expect(f.input).toHaveValue('Keep ')
  }
  expect(f.operations.filter(row => row.op === 'chat-config-set').some(row => row.args.configId === 'model')).toBe(false)
  expect(f.operations.some(row => ['chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('provider-specific settings support boolean speed, grouped effort and extra model controls', async ({ page }) => {
  const f = await fixture(page, true, undefined, { provider: 'antigravity', availableCommands: [], sessionConfig: [
    { id: 'vendor-fast', name: 'Response speed', category: 'model_config', type: 'boolean', currentValue: false },
    { id: 'vendor-thinking', name: 'Thinking level', category: 'model_config', type: 'select', currentValue: 'minimal', options: [
      { group: 'thinking', name: 'Thinking levels', options: [{ value: 'minimal', name: 'Minimal' }, { value: 'maximum', name: 'Maximum' }] },
    ] },
    { id: 'verbosity', name: 'Verbosity', category: 'model_config', type: 'select', currentValue: 'full', options: [
      { value: 'full', name: 'Full' }, { value: 'brief', name: 'Brief' },
    ] },
  ] })
  for (const [token, label, configId, value] of [
    ['@fast:on', 'Fast', 'vendor-fast', true],
    ['@speed:normal', 'Normal', 'vendor-fast', false],
    ['@thinking:maximum', 'Maximum', 'vendor-thinking', 'maximum'],
    ['@verbosity:brief', 'Brief', 'verbosity', 'brief'],
  ] as const) {
    await f.input.fill(`Keep ${token}`)
    await page.getByRole('option', { name: new RegExp(`^${label} `) }).click()
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').at(-1)?.args).toMatchObject({ configId, value })
    await expect(f.input).toHaveValue('Keep ')
  }
  await f.input.fill('@effort:high')
  await expect(page.getByRole('status').filter({ hasText: 'No effort options match' })).toBeVisible()
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(4)
})

test('new-chat settings discovery preserves draft selectors without a session', async ({ page }) => {
  const f = await fixture(page, false)
  await f.input.fill('Keep @effort:high')
  await page.getByRole('option', { name: /^High / }).click()
  await expect(f.input).toHaveValue('Keep ')
  expect(f.operations.some(row => ['chat-config-set', 'chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args.initialConfig).toContainEqual({ id: 'provider-effort', value: 'high' })
})

test('direct new-chat speed mentions do not prepare a session', async ({ page }) => {
  const f = await fixture(page, false)
  await f.input.fill('Keep @speed:fast')
  await page.getByRole('option', { name: /^Fast / }).click()
  await expect(f.input).toHaveValue('Keep ')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('speed mention retries retain an absolute value instead of toggling', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await f.input.fill('Keep @fast:on')
  await page.getByRole('option', { name: /^Fast / }).click()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(f.input).toHaveValue('Keep ')
  const attempts = f.operations.filter(row => row.op === 'chat-config-set')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].args).toEqual(attempts[0].args)
  expect(attempts[1].args).toMatchObject({ configId: 'serviceTier', value: 'fast' })
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
})

test('mention choices follow updated model capabilities and stay unavailable during a turn', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('@effort:')
  await expect(page.getByRole('option', { name: /^High / })).toBeVisible()
  f.patch({ model: 'two', sessionConfig: [
    { id: 'reasoningEffort', name: 'Reasoning effort', category: 'model_config', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
  ] })
  await expect(page.getByRole('option', { name: /^High / })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /^Low / })).toBeVisible()
  await f.input.fill('@fast')
  await expect(page.getByRole('option', { name: /^Speed/ })).toHaveCount(0)
  await f.input.fill('@effort:low')
  f.patch({ status: 'running', turnId: 'turn-running' })
  await expect(page.getByRole('listbox', { name: 'Effort suggestions' })).toHaveCount(0)
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(0)
  f.patch({ status: 'ready', turnId: null })
  await page.getByRole('option', { name: /^Low / }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').at(-1)?.args).toMatchObject({ configId: 'reasoningEffort', value: 'low' })
})
