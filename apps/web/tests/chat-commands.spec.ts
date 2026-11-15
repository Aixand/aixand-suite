import { openComposerNotices, expect, openAdvancedModelSettings, openChatModelSettings, openChatSettings, openReasoningSettings, setCustomChatModel, test, type Page, type WebSocketRoute } from './fixtures'
import { activeComposerCommand, commandInput, settingValue, type ChatCommand } from '../src/chats/commands'
import { activeFileMention, fileMentions, fileToken, removeFileReference, resolvePromptReferences } from '../src/chats/fileReferences'
import type { ChatSnapshot } from '../src/chats/model'
import type { Backend, Catalog, Profile } from '../src/agents/client'
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
async function fixture(page: Page, existing = true, loseOnce?: 'chat-create' | 'chat-config-set' | 'chat-send' | 'chat-command', overrides: Partial<ChatSnapshot> = {}, setup: {
  backends?: Backend[]; failCreate?: boolean; discoveryDelay?: number; discoveryFail?: boolean; discoveryEmptyModel?: boolean; emptyAcpDiscovery?: boolean; home?: boolean
  readiness?: Profile['readiness']; preferred?: boolean; profiles?: Profile[]; holdProfile?: boolean; holdDiscovery?: boolean; capabilities?: Catalog['capabilities']
  failOnce?: { op: string; code: string; message: string; uncertain?: boolean; setup?: Profile['readiness']; diagnosticId?: string }
  confirmModelCompaction?: boolean
  discoverySettings?: ChatSnapshot['sessionConfig']
  holdPreview?: boolean
  creationOutcome?: 'uncertain' | 'failed' | 'created'
} = {}) {
  if (setup.home) await mockHomeOverview(page)
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let lastDiscovery: Record<string, unknown> = {}
  let profileConnection: ((error?: string) => void) | undefined
  let discoveryResponse: ((error?: string) => void) | undefined
  let resourcePreview: ((error?: string) => void) | undefined
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
  let confirmConfiguration: (() => void) | undefined
  await page.routeWebSocket('**/api/carrier/ws', route => {
    route.send(JSON.stringify({ type: 'ready' })); route.onMessage(raw => { const { id } = JSON.parse(String(raw)); route.send(JSON.stringify({ type: 'result', id, result: [] })) })
  })
  await page.routeWebSocket('**/api/agents/ws', route => {
    socket = route; route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const { id, op, args } = JSON.parse(String(raw)); operations.push({ op, args })
      if (op === 'chat-connect' && setup.holdProfile) {
        profileConnection = error => route.send(JSON.stringify(error ? { type: 'error', id, code: 'manager', message: error } : { type: 'result', id, result: {} }))
        return
      }
      if (op === 'launch-preview' && setup.holdPreview) {
        resourcePreview = error => route.send(JSON.stringify(error ? { type: 'error', id, code: 'manager', message: error } :
          { type: 'result', id, result: { report: { items: [] } } }))
        return
      }
      if (op === setup.failOnce?.op) {
        const failure = setup.failOnce; setup.failOnce = undefined
        route.send(JSON.stringify({ type: 'error', id, ...failure })); return
      }
      let result: unknown = []
      if (op === 'catalog') result = { profiles: setup.profiles ?? [{ id: `${current.provider}/work`, provider: current.provider, profile: 'work', auth: null, active_runs: 0, readiness: setup.readiness, preferred: setup.preferred }], auths: [], capabilities: setup.capabilities ?? [], cwd: '/workspace',
        ...(setup.backends ? { backends: setup.backends } : current.backend ? { backends: [{ id: current.backend, provider: current.provider, available: true, label: 'SDK fixture', modelInput: 'text', commandPreview: sdkPreview(current.provider), controls: { model: true, instructions: true, skills: true, mcp: true, suiteTools: true, voice: false, terminal: false } }] } : {}) }
      else if (op === 'project-list') result = [{ id: projectId, name: 'Studio', path: '/workspace/studio' },
        { id: otherProjectId, name: 'Lab', path: '/workspace/lab' }]
      else if (op === 'project-discovery-list') result = { jobs: [], nextOffset: null }
      else if (op === 'session-start') result = { session_id: 'terminal-fixture' }
      else if (op === 'sessions') result = { runs: [], runtimeError: null }
      else if (op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      else if (op === 'profile-resources-get') result = { revision: 'fixture-resources', instructions: null, skills: [], mcp: [] }
      else if (op === 'launch-preview') result = { report: { items: [] } }
      else if (op === 'mcp-catalog') result = { servers: [] }
      else if (op === 'chat-list') result = created ? [current] : []
      else if (op === 'chat-create-status') {
        const state = setup.creationOutcome ?? (current.creation?.state === 'failed' ? 'failed' : created ? 'created' : 'uncertain')
        const creation = { requestId: String(args.key), state, sessionConfirmed: state === 'created' }
        current = { ...current, creation, ...(state === 'created' && current.initialConfiguration?.state === 'pending' ? {
          initialConfiguration: { ...current.initialConfiguration, state: 'failed' as const },
        } : {}) }
        result = { ...creation, error: state === 'failed' ? current.error || 'Provider setup failed before creation.' : null,
          chat: created ? current : null }
      }
      else if (op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      else if (op === 'models') result = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]
      else if (op === 'backend-discovery-get' || op === 'backend-discovery-refresh') {
        const catalog = { id: `${args.profile}:${args.backend}:${args.projectId ?? ''}`, epoch: 'fixture-epoch', generation: id, sequence: operations.length,
          provider: args.provider, profile: args.profile, backend: args.backend, sourceRevision: 'fixture-source',
          state: setup.discoveryDelay ? 'running' : setup.discoveryFail ? 'error' : 'ready', discoveredAt: Date.now(),
          models: current.sessionConfig?.find(row => row.category === 'model')?.options?.flatMap(row => 'options' in row ? row.options : [row]).map(row => ({ id: row.value, name: row.name })) ?? [],
          settings: setup.discoverySettings ?? current.sessionConfig ?? [], modelsSource: 'sdk', limitations: [], error: setup.discoveryFail ? 'Discovery is unavailable.' : '',
          commands: [...(current.availableCommands ?? []).filter(row => args.provider !== 'antigravity' || row.name !== 'compact').map(row => ({ ...row, startsConversation: row.execution === 'prompt' })),
            ...(args.provider === 'antigravity' ? [{ name: 'compact', description: 'Compact context', execution: 'unsupported', reason: 'Manual compaction is not available in this SDK.' }] : []),
            { name: 'commands', description: 'Refresh available models and commands', execution: 'client', action: 'connect' }] }
        lastDiscovery = catalog
        result = setup.discoveryDelay || setup.discoveryFail ? { ...catalog, settings: setup.discoveryEmptyModel ? [
          { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: '', options: [] },
        ] : [], models: [], commands: [] } : catalog
        if (setup.emptyAcpDiscovery && args.backend === 'copilot-acp') result = { ...catalog, models: [], settings: [], commands: [] }
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
          current = { ...current, backendRoute: 'managed', status: 'failed', error: 'Configured ACP adapter executable is unavailable; install it explicitly',
            creation: { requestId: String(args.key), state: 'failed', sessionConfirmed: false } }
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
        if (setup.confirmModelCompaction) {
          current = { ...current, revision: current.revision + 1, requests: [{ requestId: 'model-compaction', method: 'sdk/question',
            params: { kind: 'user_input', questions: [{ id: 'model-compaction', header: 'Change model', question: 'Compact before switching?',
              options: [{ label: 'Compact history and switch' }, { label: 'Keep current model' }] }] } }] }
          route.send(JSON.stringify({ type: 'chat-updated', chat: current }))
          confirmConfiguration = () => {
            current = { ...current, revision: current.revision + 1, requests: [], model: args.value,
              sessionConfig: current.sessionConfig?.map(row => row.id === args.configId ? { ...row, currentValue: args.value } : row) }
            route.send(JSON.stringify({ type: 'chat-updated', chat: current }))
            route.send(JSON.stringify({ type: 'result', id, result: current }))
          }
          return
        }
        current = { ...current, revision: current.revision + 1, ...(args.configId === 'model' ? { model: args.value } : {}),
          sessionConfig: current.sessionConfig?.map(row => row.id === args.configId ? { ...row, currentValue: args.value } : row) }
        route.send(JSON.stringify({ type: 'chat-updated', chat: current })); result = current
      } else if (op === 'chat-answer' && confirmConfiguration) { confirmConfiguration(); confirmConfiguration = undefined; result = { answered: true } }
      else if (op === 'project-files-list') result = { projectId, path: '', entries: [{ name: 'My File.ts', path: 'My File.ts', kind: 'file', supported: true, size: 20, modifiedAt: 1 }], total: 1, nextOffset: null, limited: false }
      else if (op === 'project-file-read') result = { projectId, path: args.path, name: 'My File.ts', kind: 'text', content: 'export const included = true', truncated: false, size: 20, modifiedAt: 1 }
      if (op === 'backend-discovery-get' && setup.holdDiscovery) {
        setup.holdDiscovery = false
        discoveryResponse = error => route.send(JSON.stringify(error ? { type: 'error', id, code: 'busy', message: error } : { type: 'result', id, result }))
        return
      }
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
  return { input, operations, finishDiscovery: (error?: string) => discoveryResponse?.(error), finishPreview: (error?: string) => resourcePreview?.(error), finishProfile: (error?: string) => profileConnection?.(error), discoveryPatch: (patch: object) => socket.send(JSON.stringify({ type: 'backend-discovery-updated', discovery: {
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

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} model space opens inline choices and filters without sending a message`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, { home })
    await f.input.fill('/model')
    await f.input.press('Space')
    const menu = page.getByRole('listbox', { name: 'Model suggestions', exact: true })
    await expect(menu.getByRole('option', { name: /^One/ })).toBeVisible()
    await expect(menu.getByRole('option', { name: /^Two/ })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await f.input.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(f.input).toHaveValue('/model ')
    await f.input.press('Backspace')
    await f.input.press('Space')
    await f.input.pressSequentially('tw')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await f.input.press('Enter')
    await expect(f.input).toHaveValue('')
    await expect(f.input).toBeFocused()
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
    await f.input.fill('/model ')
    await menu.getByRole('option', { name: /^One/ }).click()
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('One')
    await expect(f.input).toBeFocused()
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })
}

test('existing chat model dropdown supports arrow keys and Tab and applies only the selected setting', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('/model ')
  const menu = page.getByRole('listbox', { name: 'Model suggestions', exact: true })
  await expect(menu.getByRole('option', { name: 'One', exact: true })).toHaveAttribute('aria-selected', 'true')
  await f.input.press('ArrowDown')
  await expect(menu.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
  await f.input.press('Tab')
  await expect(f.input).toHaveValue('')
  await expect(f.input).toBeFocused()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => row.args)).toEqual([
    expect.objectContaining({ chatId, configId: 'model', value: 'two' }),
  ])
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} slash commands work after text and keep the draft when choosing a model`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, { home })
    const prefix = 'Review this work\nKeep this direction '
    await f.input.fill(prefix + '/')
    const commands = page.getByRole('listbox', { name: 'Commands suggestions', exact: true })
    await expect(commands.getByRole('option', { name: /^\/model / })).toBeVisible()
    await f.input.pressSequentially('mo')
    await f.input.press('Enter')
    await expect(f.input).toHaveValue(prefix + '/model ')
    const models = page.getByRole('listbox', { name: 'Model suggestions', exact: true })
    await expect(models.getByRole('option', { name: /^Two/ })).toBeVisible()
    await f.input.pressSequentially('tw')
    await f.input.press('Enter')
    await expect(f.input).toHaveValue(prefix)
    await expect(f.input).toBeFocused()
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })
}

test('slash commands complete at the cursor and keep the text following it', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Before /mo after\nLast line')
  await f.input.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange('Before /mo'.length, 'Before /mo'.length))
  await f.input.press('Tab')
  await expect(f.input).toHaveValue('Before /model after\nLast line')
  await page.getByRole('listbox', { name: 'Model suggestions', exact: true }).getByRole('option', { name: 'Two', exact: true }).click()
  await expect(f.input).toHaveValue('Before after\nLast line')
  await expect(f.input).toBeFocused()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-config-set')?.args.value).toBe('two')
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('inline slash settings and help preserve file references without sending the draft', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Review @file:My')
  await page.getByRole('option', { name: /^My File.ts/ }).click()
  const prefix = await f.input.inputValue()
  await f.input.pressSequentially('/fast')
  await f.input.press('Enter')
  await page.getByRole('listbox', { name: 'Speed suggestions', exact: true }).getByRole('option', { name: 'Fast', exact: true }).click()
  await expect(f.input).toHaveValue(prefix)
  await expect(page.getByRole('group', { name: 'Project file references', exact: true })).toContainText('My File.ts')
  await f.input.pressSequentially('/help')
  await f.input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Available commands', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(f.input).toHaveValue(prefix)
  await expect(page.getByRole('group', { name: 'Project file references', exact: true })).toContainText('My File.ts')
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('an unmatched inline slash does not submit the surrounding message', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Keep this direction /no-such-command')
  await expect(page.getByRole('listbox', { name: 'Commands suggestions', exact: true })).toBeVisible()
  await f.input.press('Enter')
  await expect(f.input).toHaveValue('Keep this direction /no-such-command')
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} all advertised setting commands use inline choices and retain draft settings until Send`, async ({ page }, testInfo) => {
    if (home) await page.setViewportSize({ width: 390, height: 844 })
    const f = await fixture(page, false, undefined, { availableCommands: [...commands,
      { name: 'effort', description: 'Choose effort', execution: 'setting', configId: 'provider-effort' },
      { name: 'mode', description: 'Choose mode', execution: 'setting', configId: 'mode' },
      { name: 'config:verbose', description: 'Choose verbose output', execution: 'setting', configId: 'verbose' },
    ] }, { home })
    const prefix = 'Keep these instructions\nReview the work '
    for (const [command, label, value] of [
      ['reasoning', 'Reasoning effort', 'High'], ['effort', 'Reasoning effort', 'Auto'],
      ['fast', 'Speed', 'Fast'], ['mode', 'Agent mode', 'Plan'], ['plan', 'Agent mode', 'Default'],
      ['permissions', 'Permissions', 'Workspace'], ['config:verbose', 'Verbose output', 'On'], ['config:verbose', 'Verbose output', 'Off'],
    ]) {
      await f.input.fill(prefix + '/' + command)
      await f.input.press('Space')
      const options = page.getByRole('listbox', { name: `${label} suggestions`, exact: true })
      await expect(options.getByRole('option', { name: value, exact: true })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      if (command === 'reasoning') await page.screenshot({ path: testInfo.outputPath('reasoning-dropdown.png') })
      await f.input.pressSequentially(value.toLowerCase())
      await expect(options.getByRole('option')).toHaveCount(1)
      await f.input.press('Enter')
      await expect(f.input).toHaveValue(prefix)
      await expect(f.input).toBeFocused()
    }
    expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
    await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
    expect(f.operations.find(row => row.op === 'chat-create')?.args.initialConfig).toEqual(expect.arrayContaining([
      { id: 'provider-effort', value: 'default' }, { id: 'serviceTier', value: 'fast' }, { id: 'mode', value: 'default' },
      { id: 'permissions', value: ':workspace' }, { id: 'verbose', value: false },
    ]))
  })
}

test('reasoning command menu, help and keyboard choices all use the same inline setting dropdown', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Keep this /rea')
  await f.input.press('Enter')
  await expect(f.input).toHaveValue('Keep this /reasoning ')
  const options = page.getByRole('listbox', { name: 'Reasoning effort suggestions', exact: true })
  await f.input.press('ArrowDown')
  await expect(options.getByRole('option', { name: 'High', exact: true })).toHaveAttribute('aria-selected', 'true')
  await f.input.press('Tab')
  await expect(f.input).toHaveValue('Keep this ')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('High')
  await f.input.pressSequentially('/help')
  await f.input.press('Enter')
  await page.getByRole('dialog', { name: 'Available commands', exact: true }).getByRole('button', { name: '/reasoning', exact: true }).click()
  await expect(f.input).toHaveValue('Keep this /reasoning ')
  await expect(options).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await f.input.press('Escape')
  await expect(options).toHaveCount(0)
  await expect(f.input).toHaveValue('Keep this /reasoning ')
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => row.args)).toEqual([
    expect.objectContaining({ configId: 'provider-effort', value: 'high' }),
  ])
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('provider-specific setting dropdowns support grouped effort values and explicit boolean false', async ({ page }) => {
  const f = await fixture(page, true, undefined, { availableCommands: [
    { name: 'effort', description: 'Choose thinking level', execution: 'setting', configId: 'vendor-thinking' },
    { name: 'config:fast', description: 'Choose response speed', execution: 'setting', configId: 'vendor-fast' },
  ], sessionConfig: [
    { id: 'vendor-thinking', category: 'model_config', name: 'Thinking level', type: 'select', currentValue: 'minimal', options: [
      { group: 'thinking', name: 'Thinking levels', options: [{ value: 'minimal', name: 'Minimal' }, { value: 'maximum', name: 'Maximum' }] },
    ] },
    { id: 'vendor-fast', category: 'model_config', name: 'Response speed', type: 'boolean', currentValue: true },
  ] })
  await f.input.fill('Before /effort max after')
  await f.input.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange('Before /effort max'.length, 'Before /effort max'.length))
  await page.getByRole('listbox', { name: 'Thinking level suggestions', exact: true }).getByRole('option', { name: 'Maximum', exact: true }).click()
  await expect(f.input).toHaveValue('Before  after')
  await f.input.fill('Keep /config:fast ')
  await page.getByRole('listbox', { name: 'Response speed suggestions', exact: true }).getByRole('option', { name: 'Off', exact: true }).click()
  await expect(f.input).toHaveValue('Keep ')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').length).toBe(2)
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([
    ['vendor-thinking', 'maximum'], ['vendor-fast', false],
  ])
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('an open setting dropdown follows provider option updates and blocks changes during an active turn', async ({ page }) => {
  const f = await fixture(page)
  await f.input.fill('Keep /reasoning ')
  const options = page.getByRole('listbox', { name: 'Reasoning effort suggestions', exact: true })
  await expect(options.getByRole('option', { name: 'High', exact: true })).toBeVisible()
  f.patch({ sessionConfig: [{ id: 'provider-effort', category: 'model_config', name: 'Reasoning effort', type: 'select', currentValue: 'medium',
    options: [{ value: 'medium', name: 'Medium' }] }] })
  await expect(options.getByRole('option', { name: 'High', exact: true })).toHaveCount(0)
  await expect(options.getByRole('option', { name: 'Medium', exact: true })).toBeVisible()
  f.patch({ status: 'running', turnId: 'turn-running' })
  await expect(options.getByRole('option')).toHaveCount(0)
  await f.input.press('Enter')
  await expect(f.input).toHaveValue('Keep /reasoning ')
  expect(f.operations.some(row => ['chat-config-set', 'chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

test('reasoning dropdown waits for discovered settings and selects them without starting a conversation', async ({ page }) => {
  const f = await fixture(page, false, undefined, {}, { home: true, discoveryDelay: 1500,
    backends: [{ id: 'native-codex', provider: 'codex', label: 'Codex', available: true, commandPreview: commands, controls: { model: true } }] })
  await f.input.fill('Keep /reasoning ')
  await expect(page.locator('.inbox-mention-popover').getByRole('status')).toHaveText('Loading setting choices…')
  await page.getByRole('listbox', { name: 'Reasoning effort suggestions', exact: true }).getByRole('option', { name: 'High', exact: true }).click()
  await expect(f.input).toHaveValue('Keep ')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('High')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(f.operations.some(row => ['chat-config-set', 'chat-create', 'chat-send', 'chat-command'].includes(row.op))).toBe(false)
})

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
  await expect(page.getByRole('listbox', { name: 'Speed suggestions', exact: true }).getByRole('option', { name: 'Fast', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
})

test('a failed initial configuration blocks Send until current settings are explicitly accepted', async ({ page }) => {
  const f = await fixture(page, true, undefined, { status: 'failed', initialConfiguration: {
    state: 'failed', requested: [{ id: 'removed', value: 'old' }],
  } })
  await f.input.fill('Keep my first message')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
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
  await page.getByRole('listbox', { name: 'Model suggestions', exact: true }).getByRole('option', { name: /^Two/ }).click()
  expect(f.operations.some(row => ['chat-create', 'chat-config-set'].includes(row.op))).toBe(false)
  await f.input.fill('Use the chosen model'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const args = f.operations.find(row => row.op === 'chat-create')!.args
  expect(args.backend).toBe('copilot-acp')
  expect(args.model).toBeUndefined()
  expect(args.initialConfig).toContainEqual({ id: 'model', value: 'two' })
})

test('Copilot SDK model choice uses the selected SDK backend at launch', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'copilot', backend: 'copilot-sdk', backendRoute: 'managed' }, {
    backends: [{ id: 'copilot-sdk', provider: 'copilot', label: 'Copilot SDK', available: true,
      commandPreview: commands, controls: { model: true, sessionConfig: true, mcp: true } }],
  })
  await f.input.fill('/model')
  await page.getByRole('option', { name: /^\/model Change model/ }).click()
  await page.getByRole('listbox', { name: 'Model suggestions', exact: true }).getByRole('option', { name: /^Two/ }).click()
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
  await f.input.fill('Use the chosen model'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const args = f.operations.find(row => row.op === 'chat-create')!.args
  expect(args.backend).toBe('copilot-sdk')
  expect(args.model).toBe('two')
})

test('Copilot model compaction remains answerable while its setting is pending', async ({ page }) => {
  const f = await fixture(page, true, undefined, { provider: 'copilot', backend: 'copilot-sdk', backendRoute: 'managed' }, { confirmModelCompaction: true })
  await f.input.fill('/model')
  await page.getByRole('option', { name: /^\/model Change model/ }).click()
  await page.getByRole('listbox', { name: 'Model suggestions', exact: true }).getByRole('option', { name: /^Two/ }).click()
  await page.getByRole('button', { name: 'Compact history and switch', exact: true }).click()
  await page.getByRole('button', { name: 'Send answers', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-answer').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-answer')?.args.answers).toEqual({ 'model-compaction': 'Compact history and switch' })
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
  await expect(page.getByRole('button', { name: / Model$/ })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Send answers', exact: true })).toHaveCount(0)
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(1)
  expect(f.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
})

for (const [provider, backend] of [['codex', 'native-codex'], ['opencode', 'opencode-native']]) {
  test(`${provider} Home model command explains failed empty discovery and retries without starting a chat`, async ({ page }) => {
    const setup = { home: true, discoveryFail: true, discoveryEmptyModel: provider === 'codex', backends: [
      { id: backend, provider, label: provider, available: true, default: true, commandPreview: commands, controls: { model: true } },
    ] }
    const f = await fixture(page, false, undefined, { provider, backend, backendRoute: 'managed' }, setup)
    await f.input.fill('/model')
    await f.input.press('Enter')
    const picker = page.locator('.inbox-mention-popover')
    await expect(picker.getByRole('status')).toHaveText('Couldn’t load models: Discovery is unavailable.')
    await expect(picker.getByRole('option', { name: /^Two/ })).toHaveCount(0)
    expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
    setup.discoveryFail = false
    await picker.getByRole('button', { name: 'Refresh models', exact: true }).click()
    await picker.getByRole('option', { name: /^Two/ }).click()
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two')
    await f.input.fill('Use the selected model'); await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
    expect(f.operations.find(row => row.op === 'chat-create')?.args.model).toBe('two')
  })
}

test('Home model command shows loading until choices arrive', async ({ page }) => {
  const f = await fixture(page, false, undefined, {}, { home: true, discoveryDelay: 2000, discoveryEmptyModel: true,
    backends: [{ id: 'native-codex', provider: 'codex', label: 'Codex', available: true,
      commandPreview: commands, controls: { model: true } }] })
  await f.input.fill('/model'); await f.input.press('Enter')
  const picker = page.locator('.inbox-mention-popover')
  await expect(picker.getByRole('status')).toHaveText('Loading models…')
  await expect(picker.getByRole('button', { name: 'Refresh models', exact: true })).toBeDisabled()
  await expect(picker.getByRole('option', { name: /^Two/ })).toBeVisible()
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
})

test('Copilot explains session-only model discovery in both model pickers', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'copilot', backend: 'copilot-acp', backendRoute: 'managed', sessionConfig: [], availableCommands: [] }, {
    home: true, backends: [{ id: 'copilot-acp', provider: 'copilot', label: 'Copilot ACP', available: true, default: true,
      commandPreview: [], controls: { model: false, sessionConfig: true } }],
  })
  await f.input.fill('/model'); await f.input.press('Enter')
  const picker = page.locator('.inbox-mention-popover')
  await expect(picker.getByRole('status')).toHaveText('Copilot ACP does not provide a model list before a conversation starts. Use Copilot SDK to choose a model now.')
  await expect(picker.getByRole('button', { name: 'Set up Copilot SDK' })).toBeVisible()
  await page.keyboard.press('Escape')
  const settings = await openChatModelSettings(page)
  await expect(settings.getByRole('status')).toHaveText('Copilot ACP does not provide a model list before a conversation starts. Use Copilot SDK to choose a model now.')
  await expect(settings.getByRole('button', { name: 'Set up Copilot SDK' })).toBeVisible()
  await expect(settings.getByRole('button', { name: /custom model…$/ })).toHaveCount(0)
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
})

test('Copilot model picker can explicitly switch the draft to the installed SDK', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'copilot', backend: 'copilot-acp', backendRoute: 'managed' }, {
    emptyAcpDiscovery: true, backends: [
      { id: 'copilot-acp', provider: 'copilot', label: 'Copilot ACP', available: true, default: true, commandPreview: commands,
        controls: { model: false, sessionConfig: true } },
      { id: 'copilot-sdk', provider: 'copilot', label: 'Copilot SDK', available: true, commandPreview: commands,
        controls: { model: true, sessionConfig: true } },
    ],
  })
  await f.input.fill('/model'); await f.input.press('Enter')
  const picker = page.locator('.inbox-mention-popover')
  await picker.getByRole('button', { name: 'Use Copilot SDK', exact: true }).click()
  await expect(picker.getByRole('option', { name: /^Two/ })).toBeVisible()
  await picker.getByRole('option', { name: /^Two/ }).click()
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  await f.input.fill('Use the selected SDK model'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args).toMatchObject({ backend: 'copilot-sdk', model: 'two' })
})

for (const provider of ['claude', 'antigravity']) {
  test(`${provider} model command explains API setup without treating a terminal login as chat authentication`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { provider, backend: `${provider}-sdk`, sessionConfig: [] }, {
      home: true, preferred: true, discoveryFail: true, readiness: { ready: true, chat: { ready: false, reason: 'Choose an API credential for embedded chat.' } },
      backends: [{ id: `${provider}-sdk`, provider, label: provider, available: true, commandPreview: commands, controls: { model: true } }],
    })
    await f.input.fill('/model'); await f.input.press('Enter')
    const picker = page.locator('.inbox-mention-popover')
    await expect(picker.getByRole('status')).toHaveText('Choose an API credential for embedded chat.')
    await expect(picker.getByRole('button', { name: 'Refresh models', exact: true })).toBeDisabled()
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
}

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
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
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
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args.backend).toBe('claude-sdk')
})

for (const failed of [false, true]) test(`resource validation ${failed ? 'keeps failed previews blocked' : 'finishes'} after Chat settings closes`, async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed' }, { holdPreview: true })
  await openChatSettings(page)
  await expect.poll(() => f.operations.filter(row => row.op === 'launch-preview').length).toBe(1)
  await page.keyboard.press('Escape')
  await f.input.fill('Send after resource validation')
  const send = page.getByRole('button', { name: 'Start agent', exact: true })
  await expect(send).toBeDisabled()
  f.finishPreview(failed ? 'Selected instructions are unavailable.' : undefined)
  if (failed) {
    const settings = await openChatSettings(page)
    await settings.locator('summary').filter({ hasText: /^Resources$/ }).click()
    await expect(settings.getByRole('alert')).toHaveText('Selected instructions are unavailable.')
    await page.keyboard.press('Escape')
    await expect(send).toBeDisabled()
    expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
  } else {
    await expect(send).toBeEnabled()
    await f.input.press('Enter')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  }
})

test('invalid instruction input remains visible and blocks submission after reopening Chat settings', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed' })
  let settings = await openChatSettings(page)
  await settings.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await settings.getByText('Instruction inputs (JSON)', { exact: true }).click()
  await settings.getByRole('textbox', { name: 'Resource instruction inputs', exact: true }).fill('{')
  await page.keyboard.press('Escape')
  await f.input.fill('Keep this prompt')
  const send = page.getByRole('button', { name: 'Start agent', exact: true })
  await expect(send).toBeDisabled()
  settings = await openChatSettings(page)
  await settings.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await settings.getByText('Instruction inputs (JSON)', { exact: true }).click()
  await expect(settings.getByRole('textbox', { name: 'Resource instruction inputs', exact: true })).toHaveValue('{')
  await settings.getByRole('textbox', { name: 'Resource instruction inputs', exact: true }).fill('{}')
  await page.keyboard.press('Escape')
  await expect(send).toBeEnabled()
  await expect(f.input).toHaveValue('Keep this prompt')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
})

test('backend availability can be refreshed after installing SDKs into the Suite runtime', async ({ page }) => {
  const backends = claudeBackends(false, false)
  await fixture(page, false, undefined, { provider: 'claude', model: null, sessionConfig: undefined }, { backends })
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  backends[1].available = true
  backends[1].reason = undefined
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Claude Provider', exact: true })).toBeVisible()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
})

test('a failed ACP creation allows changing the draft backend without losing the prompt or replaying the failed launch', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', model: null, sessionConfig: undefined }, { backends: claudeBackends(true), failCreate: true })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('Keep my instructions for Claude')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  await expect(f.input).toHaveValue('Keep my instructions for Claude')
  await expect(f.input).toBeEditable()
  const settings = await openChatSettings(page)
  await settings.getByRole('button', { name: / Backend$/ }).click()
  await page.getByRole('option', { name: /Claude SDK/ }).click()
  await expect(settings.getByRole('button', { name: / Backend$/ })).toContainText('Claude SDK')
  await expect(settings.getByRole('button', { name: / Backend$/ })).toBeEnabled()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
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
  await page.getByRole('listbox', { name: 'Model suggestions', exact: true }).getByRole('option', { name: /^Two/ }).click()
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
  await expect(page.getByRole('group', { name: 'Chat connection' })).toHaveCount(0)
  const before = f.operations.filter(row => row.op === 'chat-open').length
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await page.clock.runFor(delay)
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-open').length).toBe(before + index + 1)
  }
  expect(f.operations.some(row => row.op === 'chat-backend-resume')).toBe(false)
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
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
  await openComposerNotices(page)
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
  await page.getByRole('listbox', { name: 'Agent mode suggestions', exact: true }).getByRole('option', { name: 'Plan', exact: true }).click()
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
  await f.input.fill('Start with my chosen settings'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.find(row => row.op === 'chat-create')?.args.initialConfig).toEqual([{ id: 'mode', value: 'plan' }])
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
})

test('SDK draft setting dropdown explains missing choices without creating a conversation', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: sdkCommands, sessionConfig: [] }, { holdDiscovery: true })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('/')
  await page.getByRole('option', { name: /^\/plan / }).click()
  f.finishDiscovery()
  await expect(page.getByRole('group', { name: 'Setting discovery' })).toContainText('This provider has not supplied any setting choices.')
  await expect(f.input).toHaveValue('/plan ')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(f.operations.some(row => ['chat-create', 'chat-config-set', 'chat-command', 'chat-send'].includes(row.op))).toBe(false)
})

test('a withdrawn SDK setting command closes its dropdown and keeps the draft', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed',
    availableCommands: [], sessionConfig: [] }, { holdDiscovery: true })
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude(?:\s|$)/ }).click()
  await f.input.fill('Keep /plan ')
  await expect(page.getByRole('listbox', { name: 'plan suggestions', exact: true })).toBeVisible()
  f.finishDiscovery()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(f.input).toHaveValue('Keep /plan ')
  await expect(page.getByRole('dialog')).toHaveCount(0)
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
  await page.getByRole('dialog', { name: 'Choose model', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await openChatSettings(page)
  await page.getByRole('button', { name: / Agent mode$/ }).click()
  await page.getByRole('option', { name: 'Plan', exact: true }).click()
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
  await expect(page.getByText('Discovery is unavailable.', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh discovery', exact: true })).toHaveCount(0)
  const models = await openChatModelSettings(page)
  await setCustomChatModel(page, 'my-custom-model')
  await models.getByRole('button', { name: 'Done', exact: true }).click()
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
  await openComposerNotices(page)
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
    await setCustomChatModel(page, 'chosen-sdk-model')
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
    await f.input.fill('Use my selected model')
    await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
    await f.input.press('Enter')
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
  await openComposerNotices(page)
  await expect(page.getByText('Manual compaction is not available in this SDK.', { exact: true })).toBeVisible()
  expect(f.operations.some(row => ['chat-command', 'chat-send'].includes(row.op))).toBe(false)
})

for (const width of [320, 390, 1440]) {
  test(`model selection stays simple and response controls are optional at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const f = await fixture(page)
    const composer = page.locator('.command-composer')
    await expect(composer.getByRole('button')).toHaveCount(7)
    await expect(composer.getByRole('button', { name: 'Chat settings', exact: true })).toHaveText('')
    for (const label of ['Provider', 'Profile', 'Model'])
      await expect(composer.getByRole('button', { name: new RegExp(` ${label}$`) })).toBeInViewport()
    await expect(composer.getByRole('button', { name: /Speed|effort|Permissions|Agent mode|Verbose/ })).toHaveCount(0)

    const settings = await openChatSettings(page)
    await expect(settings.getByRole('region', { name: 'Permissions & policy' })).toContainText('Read-only')
    await expect(settings.getByRole('region', { name: 'Permissions & policy' })).toContainText('On request')
    await expect(settings.getByRole('region', { name: 'Advanced', exact: true }).getByRole('button', { name: 'Verbose output: Off' })).toBeVisible()
    await expect(settings.getByRole('button', { name: /Speed|Reasoning effort/ })).toHaveCount(0)
    await settings.getByRole('button', { name: / Agent mode$/ }).click()
    await page.getByRole('option', { name: 'Plan', exact: true }).click()

    const modelSettings = await openChatModelSettings(page)
    await expect(modelSettings.getByRole('slider')).toHaveCount(0)
    await expect(modelSettings.getByRole('switch')).toHaveCount(0)
    await expect(modelSettings.getByRole('button', { name: / Agent mode$/ })).toHaveCount(0)
    await expect(modelSettings.locator('summary')).toHaveText(['Advanced'])
    await expect(modelSettings.getByText('Response settings', { exact: true })).toHaveCount(0)
    await expect(modelSettings.locator('.bbb-option__description')).toHaveCount(0)
    await expect(modelSettings.locator('.command-model-reasoning-chevron')).toHaveCount(1)
    const selected = modelSettings.getByRole('option', { selected: true })
    await expect(selected).toHaveAccessibleDescription(/Reasoning effort available.*Right Arrow/)
    if (width === 1440) await selected.hover()
    else await selected.click()
    const reasoningPanel = page.locator('.command-model-reasoning-panel')
    await expect(reasoningPanel).toBeVisible()
    const reasoning = reasoningPanel.getByRole('slider', { name: 'Reasoning effort', exact: true })
    if (width === 1440) {
      const track = (await reasoningPanel.locator('.command-reasoning-slider .bbb-slider__track').boundingBox())!
      await page.mouse.move(track.x, track.y + track.height / 2)
      await page.mouse.down()
      await page.mouse.move(track.x + track.width, track.y + track.height / 2, { steps: 5 })
      expect(f.operations.some(row => row.op === 'chat-config-set' && row.args.configId === 'provider-effort')).toBe(false)
      await page.mouse.up()
    } else await reasoning.press('End')
    await expect(reasoning).toHaveAttribute('aria-valuetext', 'High')
    if (width === 390) expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-composer/${width}-model-reasoning.png` })
    await reasoningPanel.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await expect(reasoningPanel).not.toBeVisible()
    await expect(modelSettings).toBeVisible()
    await openAdvancedModelSettings(page)
    await modelSettings.getByRole('switch', { name: 'Fast responses', exact: true }).click()
    await expect(modelSettings.getByRole('switch', { name: 'Fast responses', exact: true })).toBeChecked()
    if (width === 390) expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-composer/${width}-model-settings.png` })
    await modelSettings.getByRole('option', { name: 'Two', exact: true }).click()
    await expect(modelSettings).toBeVisible()
    await expect(modelSettings.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
    await openReasoningSettings(page)
    await expect(reasoningPanel.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoningPanel.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await modelSettings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(modelSettings).not.toBeVisible()
    await expect(composer.getByRole('button', { name: / Model$/ })).toContainText('Two/fast · High')
    await expect(composer.getByRole('button', { name: / Model$/ })).toBeFocused()
    await expect(f.input).toHaveValue('')
    await expect(page.getByLabel('Conversation context')).toContainText('Plan')
    await expect(composer.getByRole('button')).toHaveCount(7)
    expect(await composer.locator('.command-model-name').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/chat-composer/${width}-summary.png` })
    expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([
      ['mode', 'plan'], ['provider-effort', 'high'], ['serviceTier', 'fast'], ['model', 'two'],
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
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible()
  await expect(page.locator('.command-composer-status')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Two Model', exact: true })).toBeFocused()
  await expect(f.input).toHaveValue('Keep my instructions')
  expect(f.operations.filter(row => row.op === 'chat-config-set').map(row => row.args.value)).toEqual(['two'])
})

test.describe('touch model reasoning', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('the selected model opens its reasoning slider on tap and preserves the model menu', async ({ page }) => {
    const f = await fixture(page)
    await f.input.fill('Keep my instructions')
    const picker = await openChatModelSettings(page)
    await picker.getByRole('option', { selected: true }).tap()
    const reasoning = page.locator('.command-model-reasoning-panel')
    await expect(reasoning).toBeVisible()
    const track = (await reasoning.locator('.bbb-slider__track').boundingBox())!
    await page.touchscreen.tap(track.x + track.width, track.y + track.height / 2)
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').map(row => [row.args.configId, row.args.value])).toEqual([['provider-effort', 'high']])
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).tap()
    await expect(reasoning).not.toBeVisible()
    await expect(picker).toBeVisible()
    await picker.getByRole('option', { name: 'Two', exact: true }).tap()
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
    await picker.getByRole('option', { selected: true }).tap()
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).tap()
    await picker.getByRole('button', { name: 'Done', exact: true }).tap()
    await expect(picker).not.toBeVisible()
    await expect(f.input).toHaveValue('Keep my instructions')
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
})

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} displays resolved inherited model and reasoning without submitting overrides`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { sessionConfig: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'two', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] },
      { id: 'provider-effort', name: 'Reasoning effort', category: 'model_config', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    ] }, { home })
    const button = page.getByRole('button', { name: 'Two · High Model', exact: true })
    await f.input.fill('Use the inherited defaults')
    await expect(button).toBeEnabled()
    await page.mouse.move(200, 300)
    await button.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Model: Two · High · Profile default')
    const panel = await openChatModelSettings(page)
    await expect(panel.getByRole('option', { name: /^Profile default/ })).toHaveAttribute('aria-selected', 'true')
    const reasoning = await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await panel.getByRole('option', { name: 'One', exact: true }).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: 'One · High Model', exact: true })).toBeVisible()
    await openChatModelSettings(page)
    await panel.getByRole('option', { name: /^Profile default/ }).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(button).toBeVisible()
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
    await f.input.fill('Use the inherited defaults')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect.poll(() => f.operations.find(row => row.op === 'chat-create')).toBeTruthy()
    const args = f.operations.find(row => row.op === 'chat-create')!.args
    expect(args.model).toBeUndefined()
    expect(args.initialConfig ?? []).toEqual([])
  })

  test(`${home ? 'Home' : 'Chat'} labels unconfirmed reasoning as provider default and accepts an explicit choice`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { sessionConfig: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'two', defaultUnknown: true, options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] },
      { id: 'provider-effort', name: 'Reasoning effort', category: 'model_config', type: 'select', currentValue: 'low', defaultUnknown: true, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      { id: 'serviceTier', name: 'Speed', category: 'model_config', type: 'select', currentValue: 'fast', defaultUnknown: true, options: [{ value: 'default', name: 'Standard' }, { value: 'fast', name: 'Fast' }] },
    ] }, { home })
    const button = page.getByRole('button', { name: 'Profile default · Provider default Model', exact: true })
    await expect(button).toBeVisible()
    await f.input.fill('@effort:')
    await expect(page.getByRole('option', { name: /^Low / })).not.toContainText('Current')
    await f.input.press('Escape')
    await f.input.fill('Keep this draft')
    const reasoning = await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Provider default')
    await reasoning.getByRole('slider').press('End')
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    const panel = await openAdvancedModelSettings(page)
    await expect(panel.getByRole('switch', { name: 'Fast responses', exact: true })).not.toBeChecked()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Profile default · High Model', exact: true })).toBeVisible()
    await openAdvancedModelSettings(page)
    await panel.getByRole('button', { name: 'Use provider defaults', exact: true }).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(button).toBeVisible()
    await expect(f.input).toHaveValue('Keep this draft')
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })

  test(`${home ? 'Home' : 'Chat'} replaces inherited defaults when the project changes`, async ({ page }) => {
    const model = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'two', options: [{ value: 'one', name: 'One' }, { value: 'two', name: 'Two' }] }
    const effort = { id: 'provider-effort', name: 'Reasoning effort', category: 'model_config', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }
    const setup = { home, holdDiscovery: false, discoverySettings: [model, effort] }
    const f = await fixture(page, false, undefined, {}, setup)
    await expect(page.getByRole('button', { name: 'Two · High Model', exact: true })).toBeVisible()
    setup.discoverySettings = [{ ...model, currentValue: 'one' }, { ...effort, currentValue: 'low' }]
    setup.holdDiscovery = true
    const settings = await openChatSettings(page)
    await settings.getByRole('button', { name: / Project$/ }).click()
    await page.getByRole('option', { name: /^Studio(?:\s|$)/ }).click()
    await expect.poll(() => f.operations.filter(row => row.op === 'backend-discovery-get').at(-1)?.args.projectId).toBe(projectId)
    await expect(page.getByRole('button', { name: 'Two · High Model', exact: true })).toHaveCount(0)
    f.finishDiscovery()
    await expect(page.getByRole('button', { name: 'One · Low Model', exact: true })).toBeVisible()
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })

  test(`${home ? 'Home' : 'Chat'} keeps model choices and reasoning visible while a selected model is discovered`, async ({ page }) => {
    const setup = { home, holdDiscovery: false }
    const f = await fixture(page, false, undefined, {}, setup)
    await f.input.fill('Keep my model and profile settings')
    const picker = await openChatModelSettings(page)
    await expect(picker.getByRole('option', { name: 'One', exact: true })).toBeVisible()
    const reasoning = await openReasoningSettings(page)
    await reasoning.getByRole('slider').press('End')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await openAdvancedModelSettings(page)
    await picker.getByRole('switch', { name: 'Fast responses', exact: true }).click()

    setup.holdDiscovery = true
    await picker.getByRole('option', { name: 'Two', exact: true }).click()
    await expect.poll(() => f.operations.filter(row => row.op === 'backend-discovery-get' && row.args.model === 'two').length).toBe(1)
    await expect(picker.getByRole('option', { name: 'One', exact: true })).toBeVisible()
    await expect(picker.getByRole('option', { name: 'Two', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(picker.getByRole('switch', { name: 'Fast responses', exact: true })).toBeChecked()
    await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    f.finishDiscovery()
    await expect(picker.getByRole('button', { name: 'Refresh models', exact: true })).toBeEnabled()

    f.discoveryPatch({ state: 'running', models: [], settings: [], commands: [] })
    await expect(picker.getByRole('button', { name: 'Refresh models', exact: true })).toBeDisabled()
    await expect(picker.getByRole('option', { name: 'One', exact: true })).toBeVisible()
    await expect(picker.getByRole('switch', { name: 'Fast responses', exact: true })).toBeChecked()
    await expect(picker.locator('.command-model-reasoning-chevron')).toHaveCount(1)

    f.discoveryPatch({ state: 'ready', settings: [
      { id: 'provider-effort', name: 'Reasoning effort', category: 'model_config', type: 'select', currentValue: 'default',
        options: [{ value: 'default', name: 'Auto' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] },
    ] })
    await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider')).toHaveAttribute('max', '2')
    await expect(reasoning.getByRole('slider')).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await picker.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: 'work Profile', exact: true })).toBeVisible()
    await expect(f.input).toHaveValue('Keep my model and profile settings')
    expect(f.operations.some(row => ['chat-connect', 'chat-create', 'chat-config-set', 'chat-send'].includes(row.op))).toBe(false)
  })

  test(`${home ? 'Home' : 'Chat'} model search filters long lists and keeps the picker open on selection`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const f = await fixture(page, false, undefined, { sessionConfig: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'one', options: [
        { value: 'one', name: 'One' }, ...Array.from({ length: 25 }, (_, index) => ({ value: `model-${index}`, name: `Model ${index}` })),
      ] },
    ] }, { home })
    await f.input.fill('Keep this draft')
    const panel = await openChatModelSettings(page)
    const search = panel.getByRole('searchbox', { name: 'Search models', exact: true })
    await expect(search).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Use a custom model…', exact: true })).not.toBeVisible()
    expect(await panel.getByRole('listbox').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await search.fill('unmatched-model')
    await expect(panel.getByText('No models match your search.', { exact: true })).toBeVisible()
    await search.fill('Model 19')
    await expect(panel.getByRole('option')).toHaveCount(1)
    await panel.getByRole('option', { name: /^Model 19(?:\s|$)/ }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('option', { name: /^Model 19(?:\s|$)/ })).toHaveAttribute('aria-selected', 'true')
    await expect(search).toHaveValue('Model 19')
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(panel).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Model 19 Model', exact: true })).toBeFocused()
    await openChatModelSettings(page)
    await expect(search).toHaveValue('')
    await panel.getByRole('option', { name: /^Model 19(?:\s|$)/ }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('option', { name: /^Model 19(?:\s|$)/ })).toHaveAttribute('aria-selected', 'true')
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(panel).not.toBeVisible()
    await expect(f.input).toHaveValue('Keep this draft')
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })

  test(`${home ? 'Home' : 'Chat'} remembers response choices per draft profile and resets provider defaults`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, { home, profiles: ['work', 'review'].map(profile => ({
      id: `codex/${profile}`, provider: 'codex', profile, auth: null, active_runs: 0,
    })) })
    await f.input.fill('Keep my profile settings')
    const panel = await openChatModelSettings(page)
    await panel.getByRole('option', { name: /^Two(?:\s|$)/ }).click()
    const reasoning = await openReasoningSettings(page)
    await reasoning.getByRole('slider', { name: 'Reasoning effort', exact: true }).press('End')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await openAdvancedModelSettings(page)
    await panel.getByRole('switch', { name: 'Fast responses', exact: true }).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    for (const profile of ['review', 'work']) {
      await page.getByRole('button', { name: / Profile$/ }).click()
      await page.getByRole('option', { name: new RegExp(`^${profile}(?:\\s|$)`) }).click()
    }
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Two/fast · High')
    await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider', { name: 'Reasoning effort', exact: true })).toHaveAttribute('aria-valuetext', 'High')
    await reasoning.getByRole('slider').press('Escape')
    await expect(reasoning).not.toBeVisible()
    await expect(panel).toBeVisible()
    await openAdvancedModelSettings(page)
    await expect(panel.getByRole('switch', { name: 'Fast responses', exact: true })).toBeChecked()
    await panel.getByRole('button', { name: 'Use provider defaults', exact: true }).click()
    await expect(panel.getByRole('switch', { name: 'Fast responses', exact: true })).not.toBeChecked()
    await openReasoningSettings(page)
    await expect(reasoning.getByRole('slider', { name: 'Reasoning effort', exact: true })).toHaveAttribute('aria-valuetext', 'Auto')
    await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
    await panel.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: / Model$/ })).toHaveText('Two')
    await expect(f.input).toHaveValue('Keep my profile settings')
    expect(f.operations.some(row => ['chat-create', 'chat-send', 'chat-config-set'].includes(row.op))).toBe(false)
  })
}

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

test('lost first launch is inspected without recreating or sending until explicit Send', async ({ page }) => {
  const f = await fixture(page, false, 'chat-create')
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
  expect(f.operations.some(row => row.op === 'chat-create')).toBe(false)
  await f.input.fill('First message'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  await expect(f.input).toBeEditable()
  expect(f.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const creates = f.operations.filter(row => row.op === 'chat-create')
  expect(creates).toHaveLength(1)
  expect(f.operations.find(row => row.op === 'chat-create-status')?.args.key).toBe(creates[0].args.key)
})

test('recovered creation keeps captured file contents until the first explicit send', async ({ page }) => {
  const f = await fixture(page, false, 'chat-create')
  const settings = await openChatSettings(page)
  await settings.getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^Studio / }).click()
  await f.input.fill('Explain @file:')
  await page.getByRole('option', { name: /My File.ts/ }).click()
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  await expect(f.input).toBeEditable()
  expect(f.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  expect(f.operations.filter(row => row.op === 'project-file-read')).toHaveLength(1)
  expect(String(f.operations.find(row => row.op === 'chat-send')?.args.text).match(/export const included = true/g)).toHaveLength(1)
})

test('failed creation before a conversation exists returns an editable draft with a new request key', async ({ page }) => {
  const f = await fixture(page, false, undefined, {}, { creationOutcome: 'failed',
    failOnce: { op: 'chat-create', code: 'unavailable', message: 'Runtime grouping timed out' } })
  await f.input.fill('Keep this first message'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  await expect(f.input).toBeEditable()
  await expect(f.input).toHaveValue('Keep this first message')
  expect(f.operations.filter(row => row.op === 'chat-open')).toHaveLength(0)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(1)
  const creates = f.operations.filter(row => row.op === 'chat-create')
  expect(creates).toHaveLength(2)
  expect(creates[0].args.key).not.toBe(creates[1].args.key)
})

test('uncertain creation survives reload and inspection never creates or sends again', async ({ page }) => {
  const setup = { creationOutcome: 'uncertain' as 'uncertain' | 'created' }
  const f = await fixture(page, false, 'chat-create', {}, setup)
  await f.input.fill('Keep my original message'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  const key = String(f.operations.find(row => row.op === 'chat-create')!.args.key)
  await page.goto(`/#/chat/${key}`)
  await page.reload()
  await expect(f.input).toHaveValue('Keep my original message')
  await expect(f.input).toHaveAttribute('readonly', '')
  expect(f.operations.filter(row => row.op === 'chat-open')).toHaveLength(0)
  setup.creationOutcome = 'created'
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
  await page.getByRole('button', { name: 'Inspect outcome', exact: true }).click()
  await expect(f.input).toBeEditable()
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  expect(f.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
})

test('created session with failed initial settings offers enabled review after receipt inspection', async ({ page }) => {
  const f = await fixture(page, false, 'chat-create', { initialConfiguration: { state: 'pending', requested: [{ id: 'model', value: 'two' }] } })
  await f.input.fill('Keep this until settings are reviewed'); await f.input.press('Enter')
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-create-status').length).toBe(1)
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
  await expect(page.getByRole('button', { name: 'Review settings', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Use current session settings', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Use current session settings', exact: true }).click()
  await expect(f.input).toHaveValue('Keep this until settings are reviewed')
  expect(f.operations.filter(row => row.op === 'chat-create')).toHaveLength(1)
  expect(f.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
})

test('lost fast response retries the same explicit value instead of toggling again', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await f.input.fill('/fast'); await f.input.press('Enter')
  await page.getByRole('listbox', { name: 'Speed suggestions', exact: true }).getByRole('option', { name: 'Fast', exact: true }).click()
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
  await (await openAdvancedModelSettings(page)).getByRole('switch', { name: 'Fast responses', exact: true }).click()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').length).toBe(2)
  await f.input.fill('Keep my draft')
  const modelSettings = await openAdvancedModelSettings(page)
  await modelSettings.getByRole('switch', { name: 'Fast responses', exact: true }).click()
  await expect(modelSettings.getByRole('switch', { name: 'Fast responses', exact: true })).not.toBeChecked()
  await modelSettings.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toHaveText('One')
  await expect(f.input).toHaveValue('Keep my draft')
})

test('confirmed provider settings allow continuing after an uncertain response', async ({ page }) => {
  const f = await fixture(page, true, 'chat-config-set')
  await f.input.fill('/fast on'); await f.input.press('Enter')
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
  await page.getByRole('button', { name: 'Continue with confirmed settings', exact: true }).click()
  await expect(f.input).toBeEditable()
  await expect(f.input).toHaveValue('')
  await expect(page.locator('.command-composer-status')).toHaveCount(0)
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
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(2)
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
  await page.getByRole('listbox', { name: 'Permissions suggestions', exact: true }).getByRole('option', { name: 'Workspace', exact: true }).click()
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
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-send').length).toBe(2)
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
  const inline = 'Draft text\nReview /model tw'
  expect(activeComposerCommand(inline, inline.length)).toEqual({ start: inline.indexOf('/'), end: inline.length, query: 'model tw', standalone: false })
  const repeated = 'Review /help then /mo'
  expect(activeComposerCommand(repeated, repeated.length)?.start).toBe(repeated.lastIndexOf('/'))
  expect(activeComposerCommand('Before /mo after', 'Before /m'.length)).toEqual({ start: 7, end: 10, query: 'm', standalone: false })
  for (const text of ['Visit https://example.com/model', 'Read src/model', 'Example ` /model ', '```text\n/model '])
    expect(activeComposerCommand(text, text.length)).toBeNull()
  expect(activeComposerCommand('/model\nContinue the draft', '/model\nContinue the draft'.length)).toBeNull()
  expect(activeComposerCommand('/model ', -1)).toBeNull()
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
  const reasoning = await openReasoningSettings(page)
  await expect(reasoning.getByRole('slider', { name: 'Reasoning effort', exact: true })).toHaveAttribute('aria-valuetext', 'High')
  await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
  const panel = await openAdvancedModelSettings(page)
  await expect(panel.getByRole('switch', { name: 'Fast responses', exact: true })).not.toBeChecked()
  await panel.getByRole('button', { name: 'Done', exact: true }).click()
  await expect((await openChatSettings(page)).getByRole('button', { name: / Agent mode$/ })).toContainText('Plan')
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
  const reasoning = await openReasoningSettings(page)
  await expect(reasoning.getByRole('slider', { name: 'Thinking level', exact: true })).toHaveAttribute('aria-valuetext', 'Maximum')
  await reasoning.getByRole('button', { name: 'Close reasoning', exact: true }).click()
  const advanced = await openAdvancedModelSettings(page)
  await expect(advanced.getByRole('radiogroup', { name: 'Verbosity', exact: true }).getByRole('radio', { name: 'Brief', exact: true })).toBeChecked()
  await advanced.getByRole('button', { name: 'Done', exact: true }).click()
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

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} initially shows only one notice dropdown and reveals errors on request`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const reason = 'Use Open terminal for the Claude account; select an API credential for embedded chat. ' + 'Additional provider information '.repeat(8)
    const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', sessionConfig: undefined }, {
      home, preferred: true, backends: claudeBackends(false), readiness: { ready: true, chat: { ready: false, reason } },
    })
    await f.input.fill('Keep these instructions while I review setup')
    const status = page.locator('.command-composer .command-composer-status')
    const summary = status.getByRole('button', { name: '1 warning', exact: true })
    const row = status.locator('.command-composer-status-trigger')
    const popover = page.locator('.command-composer-status-popover')
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(status.getByRole('button')).toHaveCount(1)
    await expect(row).toHaveCount(0)
    await expect(page.getByText(reason.trim(), { exact: true })).toHaveCount(0)
    expect((await status.boundingBox())!.height).toBeLessThan(55)
    await summary.hover()
    await summary.focus()
    await expect(row).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('composer-notices-collapsed-mobile.png') })
    await summary.press('Enter')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(row).toBeVisible()
    await expect(status.locator('.command-composer-status-title')).toHaveCSS('-webkit-line-clamp', '2')
    await expect(popover).toHaveCount(0)
    const before = (await status.boundingBox())!
    const input = (await f.input.boundingBox())!
    await row.click()
    await expect(popover.getByRole('dialog', { name: 'Profile setup required' })).toBeVisible()
    await expect(popover.getByText(reason.trim(), { exact: true })).toBeVisible()
    await expect(popover.getByRole('button', { name: 'Review provider setup' })).toBeVisible()
    expect((await status.boundingBox())!.height).toBe(before.height)
    expect((await f.input.boundingBox())!.y).toBe(input.y)
    const bounds = (await popover.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).include('.command-composer').include('.command-composer-status-popover').analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('composer-notice-popover-mobile.png') })
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(row).toBeFocused()
    await row.press('Space')
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: 'Close notice details' }).click()
    await expect(row).toBeFocused()
    await row.click()
    await f.input.click()
    await expect(popover).toHaveCount(0)
    await row.focus()
    await row.press('Escape')
    await expect(row).toHaveCount(0)
    await expect(summary).toBeFocused()
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(f.input).toHaveValue('Keep these instructions while I review setup')
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
}

for (const scenario of [{ theme: 'light', width: 1440, height: 1000 }, { theme: 'dark', width: 390, height: 844 }]) {
  test(`long error details scroll independently in ${scenario.theme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario)
    await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), scenario.theme)
    const details = Array.from({ length: 90 }, (_, index) => `Provider detail line ${index + 1}: ${'x'.repeat(110)}`).join('\n')
    const f = await fixture(page, false, undefined, {}, { failOnce: { op: 'backend-discovery-get', code: 'manager', message: details } })
    await f.input.fill('Keep this draft while reading the full error')
    await openComposerNotices(page)
    const input = (await f.input.boundingBox())!
    const trigger = page.locator('.command-composer-status-trigger')
    await trigger.click()
    const popover = page.locator('.command-composer-status-popover')
    const body = popover.getByRole('region', { name: 'Notice details' })
    await expect(body).toContainText('Provider detail line 90')
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect((await popover.boundingBox())!.height).toBeLessThanOrEqual(scenario.height * .7)
    expect((await popover.boundingBox())!.height).toBeLessThanOrEqual(448)
    expect((await f.input.boundingBox())!.y).toBe(input.y)
    await body.focus()
    await body.press('End')
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(popover.getByRole('button', { name: 'Refresh discovery' })).toBeInViewport()
    expect((await new AxeBuilder({ page }).include('.command-composer-status-popover').analyze()).violations).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`composer-error-${scenario.theme}.png`) })
    await popover.getByRole('button', { name: 'Refresh discovery' }).click()
    await expect(popover).toHaveCount(0)
    await expect(f.input).toHaveValue('Keep this draft while reading the full error')
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
}

test('multiple errors stay in a capped scrollable list and each row opens its own details', async ({ page }) => {
  await page.addInitScript(id => localStorage.setItem(`aixand.chat.delivery.${id}`, JSON.stringify({
    messagesPaused: true, messages: Array.from({ length: 8 }, (_, index) => ({ id: `failed-${index}`, text: `Pending message ${index}`,
      mode: 'queue', status: 'failed' })),
  })), chatId)
  const f = await fixture(page)
  const summary = page.getByRole('button', { name: '8 errors', exact: true })
  await expect(summary).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.command-composer-status-trigger')).toHaveCount(0)
  await openComposerNotices(page)
  const list = page.locator('.command-composer-status-list')
  const rows = list.locator('.command-composer-status-trigger')
  await expect(rows).toHaveCount(8)
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect((await list.boundingBox())!.height).toBeLessThanOrEqual(128)
  await rows.last().scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  await rows.last().click()
  expect(await list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  const popover = page.locator('.command-composer-status-popover')
  await expect(popover.getByRole('dialog', { name: 'Error details' })).toBeVisible()
  await expect(popover).toContainText('Delivery was interrupted. Retry to check the original request.')
  await page.keyboard.press('Escape')
  await expect(rows.last()).toBeFocused()
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
})


test('unknown operation errors use the composer strip and preserve the request when retried', async ({ page }) => {
  const original = 'Agent operation failed. Check local SDK configuration and refresh; the request was not retried.'
  const f = await fixture(page, true, undefined, {}, {
    failOnce: { op: 'chat-config-set', code: 'unavailable', message: original },
  })
  await f.input.fill('Keep my unsent instructions')
  const models = await openChatModelSettings(page)
  await models.getByRole('option', { name: 'Two', exact: true }).click()
  await openComposerNotices(page)
  const status = page.locator('.command-composer-status')
  await expect(status.getByRole('alert')).toHaveText('Couldn’t complete the request.')
  await expect(page.getByRole('dialog', { name: 'Choose model' })).toHaveCount(0)
  expect(f.operations.filter(row => row.op === 'chat-config-set')).toHaveLength(1)
  const trigger = status.locator('.command-composer-status-trigger')
  await trigger.click()
  await expect(page.locator('.command-composer-status-popover').getByRole('heading', { name: 'Technical details' })).toBeVisible()
  await expect(page.locator('.command-composer-status-popover')).toContainText(original)
  await expect(f.input).toHaveValue('Keep my unsent instructions')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect.poll(() => f.operations.filter(row => row.op === 'chat-config-set').length).toBe(2)
  const requests = f.operations.filter(row => row.op === 'chat-config-set')
  expect(requests[1].args).toEqual(requests[0].args)
  await expect(f.input).toHaveValue('Keep my unsent instructions')
  await expect(status).toHaveCount(0)
})

for (const provider of ['claude', 'antigravity']) {
  test(`${provider} keeps a model button when discovery fails and accepts custom models in its panel`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { provider, backend: `${provider}-sdk`, model: null, sessionConfig: undefined }, {
      discoveryFail: true,
      backends: [{ id: `${provider}-sdk`, provider, label: `${provider} SDK`, available: true, modelInput: 'text', controls: { model: true } }],
    })
    const model = page.getByRole('button', { name: / Model$/ })
    await expect(model).toBeVisible()
    await expect(page.locator('.command-composer-options input')).toHaveCount(0)
    await openComposerNotices(page)
    await expect(page.locator('.command-composer-status-title')).toHaveText('Couldn’t refresh models and settings.')
    const settings = await openChatModelSettings(page)
    await setCustomChatModel(page, 'custom-provider-model')
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(model).toContainText('custom-provider-model')
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
}

test('provider changes remove stale discovery errors and preserve the draft', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', sessionConfig: undefined }, {
    profiles: [
      { id: 'claude/work', provider: 'claude', profile: 'work', auth: null, active_runs: 0 },
      { id: 'opencode/work', provider: 'opencode', profile: 'work', auth: null, active_runs: 0 },
    ], backends: claudeBackends(false),
    failOnce: { op: 'backend-discovery-get', code: 'unavailable', message: 'Unexpected provider metadata failure' },
  })
  await openComposerNotices(page)
  await expect(page.locator('.command-composer-status-title')).toHaveText('Couldn’t refresh models and settings.')
  await f.input.fill('Keep my draft across providers')
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^OpenCode(?:\s|$)/ }).click()
  await expect(page.locator('.command-composer-status')).toHaveCount(0)
  await expect(f.input).toHaveValue('Keep my draft across providers')
})

test.describe('touch composer notices', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('a tap opens the notice popover and another tap closes it', async ({ page }) => {
    const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk' }, {
      preferred: true, backends: claudeBackends(false), readiness: { ready: true, chat: { ready: false, reason: 'Choose an API credential for embedded chat.' } },
    })
    await openComposerNotices(page)
    const trigger = page.locator('.command-composer-status-trigger')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.tap()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await trigger.tap()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await f.input.fill('My draft stays available')
    await expect(f.input).toHaveValue('My draft stays available')
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
})

test('missing chat credentials produce one setup notice without starting discovery', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk', sessionConfig: undefined }, {
    preferred: true, discoveryFail: true, backends: claudeBackends(false),
    readiness: { ready: true, chat: { ready: false, reason: 'Select an API credential for embedded chat.' } },
  })
  await openComposerNotices(page)
  const status = page.locator('.command-composer-status')
  await expect(status).toHaveCount(1)
  await expect(status.locator('.command-composer-status-title')).toHaveText('Select an API credential for embedded chat.')
  await expect(status.locator('.command-composer-status-count')).toHaveCount(0)
  await status.locator('.command-composer-status-trigger').click()
  await expect(status.getByText('Couldn’t refresh models and settings.', { exact: true })).toHaveCount(0)
  expect(f.operations.some(row => row.op.startsWith('backend-discovery') || row.op === 'chat-connect')).toBe(false)
  await f.input.fill('Keep my draft')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
})

for (const home of [false, true]) {
  test(`${home ? 'Home' : 'Chat'} discovers draft choices without a competing startup connection`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, { home, holdProfile: true })
    await expect.poll(() => f.operations.filter(row => row.op === 'backend-discovery-get').length).toBeGreaterThan(0)
    await expect(page.locator('.command-composer-status')).toHaveCount(0)
    await f.input.fill('Keep my draft while the profile starts')
    await expect(f.input).toBeEditable()
    await expect(page.getByText('Starting your profile…', { exact: true })).toHaveCount(0)
    expect(f.operations.filter(row => row.op === 'chat-connect')).toHaveLength(0)
    await f.input.fill('/fast on')
    await f.input.press('Enter')
    await expect(page.getByRole('button', { name: / Model$/ })).toContainText('/fast')
    await expect(page.locator('.command-composer-status')).toHaveCount(0)
    expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })

  test(`${home ? 'Home' : 'Chat'} scopes discovery failures and retains the draft`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, { home, holdDiscovery: true })
    await expect.poll(() => f.operations.filter(row => row.op === 'backend-discovery-get').length).toBe(1)
    await f.input.fill('Keep these instructions if discovery fails')
    f.finishDiscovery('Busy: app-server-work-fixture; retry after the active operation finishes')
    await openComposerNotices(page)
    const status = page.locator('.command-composer-status')
    await expect(status.locator('.command-composer-status-title')).toHaveText('Couldn’t refresh models and settings.')
    await status.locator('.command-composer-status-trigger').click()
    await expect(page.locator('.command-composer-status-popover').getByRole('heading', { name: 'Technical details' })).toBeVisible()
    await expect(page.locator('.command-composer-status-popover')).toContainText('Busy: app-server-work-fixture')
    await expect(f.input).toHaveValue('Keep these instructions if discovery fails')
    expect(f.operations.some(row => ['chat-connect', 'chat-create', 'chat-send'].includes(row.op))).toBe(false)
  })
}

for (const provider of ['opencode', 'copilot']) {
  test(`a late Codex failure cannot appear on ${provider} with the same profile name`, async ({ page }) => {
    const f = await fixture(page, false, undefined, {}, {
      holdDiscovery: true,
      profiles: ['codex', provider].map(provider => ({ id: `${provider}/work`, provider, profile: 'work', auth: null, active_runs: 0 })),
      backends: [{ id: `${provider}-acp`, provider, label: provider, available: true, controls: { model: true } }],
    })
    await expect.poll(() => f.operations.some(row => row.op === 'backend-discovery-get' && row.args.provider === 'codex')).toBe(true)
    await f.input.fill('Keep my provider-independent draft')
    await page.getByRole('button', { name: / Provider$/ }).click()
    await page.getByRole('option', { name: provider === 'opencode' ? /^OpenCode(?:\s|$)/ : /copilot/i }).click()
    await expect.poll(() => f.operations.some(row => row.op === 'backend-discovery-get' && row.args.provider === provider)).toBe(true)
    f.finishDiscovery('Busy: app-server-work-fixture; retry after the active operation finishes')
    await expect(page.locator('.command-composer-status')).toHaveCount(0)
    await expect(f.input).toHaveValue('Keep my provider-independent draft')
    const models = await openChatModelSettings(page)
    await expect(models.getByRole('option', { name: /^Two(?:\s|$)/ })).toBeVisible()
  })
}

for (const provider of ['claude', 'antigravity']) {
  test(`${provider} setup opens terminal settings with Suite tools when the draft is empty`, async ({ page }) => {
    const f = await fixture(page, false, undefined, { provider, backend: `${provider}-sdk` }, {
      preferred: true,
      readiness: { ready: true, terminal: { ready: true }, chat: { ready: false, code: 'credential_required', reason: 'Select a chat API credential.' } },
      capabilities: [{ provider, installed: true, savedModels: true, budgets: false, authMode: 'native' }],
    })
    await openComposerNotices(page)
    const status = page.locator('.command-composer-status')
    await status.locator('.command-composer-status-trigger').click()
    await expect(page.locator('.command-composer-status-popover').getByRole('button', { name: 'Configure chat credentials' })).toBeVisible()
    await page.locator('.command-composer-status-popover').getByRole('button', { name: 'Open terminal', exact: true }).click()
    const terminal = page.getByRole('dialog', { name: 'Open terminal', exact: true })
    await expect(terminal.getByRole('checkbox', { name: 'Include Suite tools' })).toBeChecked()
    await expect(terminal.getByRole('textbox', { name: 'Project directory' })).toHaveValue('/workspace')
    expect(f.operations.some(row => ['session-start', 'chat-connect', 'backend-discovery-get'].includes(row.op))).toBe(false)
    await terminal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(f.input).toHaveValue('')
  })
}

test('a setup response from discovery is actionable without a generic failure', async ({ page }) => {
  const reason = 'Select a chat API credential.'
  const f = await fixture(page, false, undefined, { provider: 'antigravity', backend: 'antigravity-sdk' }, {
    failOnce: { op: 'backend-discovery-get', code: 'credential_required', message: reason,
      setup: { ready: false, code: 'credential_required', state: 'setup-required', reason } },
  })
  await openComposerNotices(page)
  const status = page.locator('.command-composer-status')
  await expect(status.locator('.command-composer-status-title')).toHaveText(reason)
  await expect(status.locator('.command-composer-status-count')).toHaveCount(0)
  await f.input.fill('Do not send until configured')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  expect(f.operations.filter(row => row.op === 'backend-discovery-get')).toHaveLength(1)
})

test('terminal submission preserves the selected project, model, resources, and Suite tools setting', async ({ page }) => {
  const f = await fixture(page, false, undefined, { provider: 'claude', backend: 'claude-sdk' }, {
    preferred: true,
    readiness: { ready: false, terminal: { ready: true }, chat: { ready: false, code: 'credential_required' } },
    capabilities: [{ provider: 'claude', installed: true, savedModels: true, budgets: false, authMode: 'native' }],
  })
  const projectSettings = await openChatSettings(page)
  await projectSettings.getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^Studio(?:\s|$)/ }).click()
  const modelSettings = await openChatModelSettings(page)
  await setCustomChatModel(page, 'terminal-model')
  await modelSettings.getByRole('button', { name: 'Done', exact: true }).click()
  const settings = await openChatSettings(page)
  await settings.locator('summary').filter({ hasText: /^Resources$/ }).click()
  await settings.getByRole('checkbox', { name: 'Include Suite tools', exact: true }).focus()
  await page.keyboard.press('Space')
  await settings.getByRole('checkbox', { name: 'Inherit profile resources', exact: true }).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Escape')
  await f.input.fill('Work on the selected project in the terminal')
  await expect(page.locator('.command-composer').getByRole('button', { name: 'Open terminal', exact: true })).toBeEnabled()
  await f.input.press('Enter')
  await expect(page).toHaveURL(/#\/terminals\/terminal-fixture$/)
  expect(f.operations.find(row => row.op === 'session-start')?.args).toMatchObject({
    provider: 'claude', profile: 'work', expectedAuth: null, cwd: '/workspace/studio', projectId,
    model: 'terminal-model', suiteTools: false, resources: { inherit_profile: false },
    prompt: 'Work on the selected project in the terminal',
  })
  expect(f.operations.filter(row => row.op === 'launch-preview').every(row => row.args.mode === 'terminal' && !row.args.backend)).toBe(true)
  expect(f.operations.some(row => ['chat-create', 'chat-send', 'backend-discovery-get'].includes(row.op))).toBe(false)
})
