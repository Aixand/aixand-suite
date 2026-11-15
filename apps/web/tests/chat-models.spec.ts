import { openChatModelSettings, openComposerNotices, setCustomChatModel, expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Catalog, LaunchReadiness, Profile } from '../src/agents/client'
import type { AgentProfile } from '../src/carrier/client'

type Operation = { id: string; op: string; args: Record<string, unknown> }

async function connect(page: Page, options: { failModels?: boolean; delayReview?: boolean; duplicateProfiles?: boolean;
  catalog?: Partial<Catalog>; carrierProfiles?: AgentProfile[]; route?: 'chat' | 'home'; discoverySetup?: LaunchReadiness;
  terminalFailure?: 'uncertain' | 'validation'; delayTerminalLaunch?: boolean; migrationRequired?: boolean; migrationFailure?: boolean;
  migrationInterrupted?: boolean; migrationUnconfirmed?: boolean; delayNativeModels?: boolean; unknownDraftSetting?: boolean } = {}) {
  const operations: Operation[] = []
  const errors: string[] = []
  page.on('pageerror', (cause) => errors.push(cause.message))
  let chat: Record<string, unknown> = {}
  const profiles: Profile[] = [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0 },
    { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, model: 'fixture/saved', active_runs: 0 },
  ]
  if (options.duplicateProfiles) profiles.push(profiles[0], {
    id: 'codex/Auto', provider: 'codex', profile: 'Auto', auth: null, active_runs: 0,
  })
  const catalog: Catalog = { profiles, auths: [], capabilities: ['codex', 'opencode'].map(provider => ({
    provider, installed: true, savedModels: true, budgets: false,
  })), backends: [
    { id: 'native-codex', provider: 'codex', label: 'Codex', available: true, controls: { model: true } },
    { id: 'opencode-native', provider: 'opencode', label: 'OpenCode', available: true, controls: { model: true, suiteTools: false } },
  ], cwd: '/workspace', ...options.catalog }
  if (!options.catalog?.backends) for (const backend of catalog.backends ?? [])
    backend.available = catalog.capabilities.some(capability => capability.provider === backend.provider && capability.installed)
  const service = { connected: true, agent_configured: true, providers: ['codex', 'opencode'], version: 1 }
  let delayedReview: (() => void) | undefined
  let delayedTerminal: (() => void) | undefined
  let delayedNativeModels: (() => void) | undefined
  await page.routeWebSocket('**/api/carrier/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Operation
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(message)
      const result = message.op === 'agent_profiles' ? options.carrierProfiles ?? (options.duplicateProfiles ? [
        { id: 'legacy-work', provider: 'codex', profile: 'work' },
        { id: 'codex/Auto', provider: 'codex', profile: 'Auto' },
      ] : []) : message.op === 'snapshot' ? { status: service, messages: [], counts: {}, total: 0, next_offset: null } :
        message.op === 'directory' ? { sessions: [], next_after: null } : message.op === 'launch' ? { status: 'active' } : []
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  let refreshCatalog = () => {}
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    refreshCatalog = () => socket.send(JSON.stringify({ type: 'profiles-changed' }))
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Operation
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(message)
      if (message.op === 'claude-account-migrate') {
        if (options.migrationFailure) {
          socket.send(JSON.stringify({ type: 'error', id: message.id, code: 'manager', message: 'Stop active Claude sessions before migrating.' }))
          return
        }
        if (options.migrationUnconfirmed) {
          socket.send(JSON.stringify({ type: 'result', id: message.id, result: { status: 'uncertain' } }))
          return
        }
        options.migrationRequired = false
        for (const profile of catalog.profiles.filter(row => row.provider === 'claude')) {
          profile.auth = null
          profile.revision = `sha256:${'b'.repeat(64)}`
          profile.readiness = { ...profile.readiness!, terminal: { ready: true, available: true, signInRequired: true } }
        }
        if (options.migrationInterrupted) {
          options.migrationInterrupted = false
          socket.send(JSON.stringify({ type: 'error', id: message.id, code: 'connection_lost', message: 'Migration response was interrupted.' }))
          return
        }
      }
      if (message.op === 'session-start' && options.terminalFailure) {
        socket.send(JSON.stringify({ type: 'error', id: message.id,
          code: options.terminalFailure === 'uncertain' ? 'connection_lost' : 'validation',
          message: options.terminalFailure === 'uncertain' ? 'Terminal launch response was interrupted' : 'Selected project is unavailable' }))
        return
      }
      const discovery = ['backend-discovery-get', 'backend-discovery-refresh'].includes(message.op)
      if ((discovery || message.op === 'models') && options.failModels) {
        socket.send(JSON.stringify({ type: 'error', id: message.id, message: 'Model discovery unavailable' }))
        return
      }
      const result = message.op === 'catalog' ? catalog :
        message.op === 'models' ? { schema: 'agent-manager/models-1', status: 'ok', error: null, models: message.args.provider === 'claude' ? [
          { id: 'sonnet', name: 'Sonnet', free: false }, { id: 'opus', name: 'Opus', free: false },
          ...['haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan'].map(id => ({ id, name: id, free: false })),
        ] : [{ id: 'gemini-fixture-high', name: 'Gemini Fixture (High)', free: false },
          { id: 'claude-fixture-medium', name: 'Claude Fixture (Medium)', free: false }] } :
        message.op === 'claude-accounts' ? { accounts: [], migrationRequired: options.migrationRequired ?? false } :
        message.op === 'claude-account-migrate' ? { migrated: true } :
        message.op === 'resource-catalog' ? { choices: { instructions: [], skills: [], mcp: [] } } :
        message.op === 'profile-resources-get' ? { revision: 'fixture', instructions: null, skills: [], mcp: [] } :
        message.op === 'launch-preview' ? { report: { items: [] } } :
        message.op === 'mcp-catalog' ? { servers: [] } :
        message.op === 'mcp-preview' ? { digest: '', project: null, states: [], selection: {} } :
        discovery ? { id: JSON.stringify(message.args), epoch: 'fixture-epoch', generation: message.id, sequence: operations.length,
          provider: message.args.provider, profile: message.args.profile, backend: message.args.backend,
          sourceRevision: 'fixture-source', state: 'ready', discoveredAt: 1, settings: options.unknownDraftSetting ? [{
            id: 'effort', name: 'Effort', category: 'model_config', type: 'select', currentValue: '', defaultUnknown: true,
            options: [{ value: 'high', name: 'High' }],
          }] : [], commands: [], limitations: [],
          ...(options.discoverySetup ? { setup: options.discoverySetup } : {}),
          models: [{ id: message.args.provider === 'codex' ? `${message.args.profile ?? 'work'}-fast` : 'fixture/free',
            name: message.args.provider === 'codex' ? `${message.args.profile ?? 'work'} Fast` : 'OpenCode Free', free: message.args.provider === 'opencode' }] } :
        message.op === 'chat-create' ? { id: message.args.key, provider: message.args.provider, backend: message.args.backend, profile: message.args.profile ?? 'work', auth: 'personal',
          model: message.args.model ?? null, cwd: '/workspace', project: '', mode: 'chat', title: 'Hello', status: 'ready',
          createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [] } :
        message.op === 'chat-send' ? { ...chat, status: 'completed', title: message.args.text, updatedAt: 2, revision: 2 } :
        message.op === 'chat-open' ? chat : message.op === 'session-start' ? { session_id: 'provider-terminal' } :
        message.op === 'sessions' ? { runs: [], runtimeError: null } :
        message.op === 'project-list' && options.unknownDraftSetting ? [{ id: 'sample', name: 'Sample', path: '/workspace/sample' }] :
        ['chat-list', 'project-list'].includes(message.op) ? [] : {}
      if (message.op === 'chat-create' || message.op === 'chat-send') chat = result as Record<string, unknown>
      const respond = () => socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
      if (discovery && message.args.profile === 'review' && options.delayReview) delayedReview = respond
      else if (message.op === 'models' && options.delayNativeModels) delayedNativeModels = respond
      else if (message.op === 'session-start' && options.delayTerminalLaunch) delayedTerminal = respond
      else respond()
    })
  })
  await page.goto(`/#/${options.route ?? 'chat'}`)
  await expect(page.getByLabel('Workspace access key')).toHaveCount(0)
  return { operations, options, errors, catalog, refreshCatalog: () => refreshCatalog(), finishReview: () => delayedReview?.(), finishTerminal: () => delayedTerminal?.(),
    finishNativeModels: () => delayedNativeModels?.() }
}

async function chooseAgent(page: Page, name: string) {
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: name === 'local' ? 'OpenCode' : 'Codex', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click()
}

test('profile selectors merge provider identities and distinguish a saved Auto profile', async ({ page }) => {
  const fixture = await connect(page, { duplicateProfiles: true })
  await openChatModelSettings(page)
  await expect.poll(() => fixture.operations.some((message) => message.op === 'agent_profiles')).toBe(true)
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.locator('.command-context-options').getByRole('option')).toHaveText(['Codex', 'OpenCode'])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option', { name: /^work codex profile/ })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /^Auto Codex/ })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /^Auto \(codex\/Auto\)/ })).toHaveCount(1)
  await page.getByRole('option', { name: /^Auto \(codex\/Auto\)/ }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use the saved profile')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-create')?.args.profile).toBe('Auto')
  expect(fixture.errors).toEqual([])
})

function terminalCatalog(provider = 'claude', options: { backendMissing?: boolean; backendUnavailable?: boolean; terminalReady?: boolean; chatReady?: boolean; migration?: boolean } = {}): Partial<Catalog> {
  const backend = provider === 'antigravity' ? 'antigravity-sdk' : `${provider}-sdk`
  return { profiles: [{ id: `${provider}/work`, provider, profile: 'work', auth: options.migration ? 'legacy-login' : null, active_runs: 0,
    revision: `sha256:${'a'.repeat(64)}`, readiness: { ready: options.chatReady ?? false,
      chat: { ready: options.chatReady ?? false, code: 'credential_required', reason: 'Configure chat API credentials' },
      terminal: options.migration ? { ready: false, available: true, code: 'claude_migration_required', signInRequired: true } :
        { ready: options.terminalReady ?? true, signInRequired: true },
      backends: { [backend]: { ready: true } } } }],
    capabilities: [{ provider, installed: true, savedModels: false, budgets: false }],
    backends: options.backendMissing ? [] : [{ id: backend, provider, label: provider, available: !options.backendUnavailable, controls: {} }],
  }
}

async function mockProviderTerminal(page: Page) {
  const operations: Operation[] = []
  await page.routeWebSocket('**/api/terminals/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Operation
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      if (message.op === 'ack') return
      operations.push(message)
      const summary = { id: 'provider-terminal', name: 'Provider session', lifecycle: { state: 'running' } }
      const result = message.op === 'list' ? { items: [summary], next_cursor: null, total: 1 } :
        message.op === 'inspect' ? { summary } :
        message.op === 'attach' ? { stream: message.args.paneId } : {}
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  return operations
}

for (const provider of ['claude', 'antigravity']) for (const route of ['chat', 'home'] as const) {
  test(`${route} ${provider} slash menu opens inline model choices without chat credentials and applies model commands`, async ({ page }, testInfo) => {
    if (route === 'home') await page.setViewportSize({ width: 390, height: 844 })
    await mockProviderTerminal(page)
    const fixture = await connect(page, { catalog: terminalCatalog(provider, { backendMissing: true }), route })
    const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
    await input.fill('/')
    const menu = page.getByRole('listbox', { name: 'Commands suggestions', exact: true })
    await expect(menu.getByRole('option', { name: /^\/model / })).toBeVisible()
    await expect(menu.getByRole('option', { name: /^\/help / })).toBeVisible()
    await expect(menu.getByRole('option', { name: /^\/permissions / })).toContainText('Opens terminal')
    await page.screenshot({ path: testInfo.outputPath('native-slash-menu.png') })
    expect(fixture.operations.some(message => message.op.startsWith('backend-discovery') || ['session-start', 'chat-create', 'chat-commands', 'claude-accounts'].includes(message.op))).toBe(false)
    await input.fill('/mo')
    await input.press('Enter')
    const picker = page.locator('.inbox-mention-popover')
    await expect(picker).toBeVisible()
    const name = provider === 'claude' ? 'Sonnet' : 'Gemini Fixture (High)'
    const id = provider === 'claude' ? 'sonnet' : 'gemini-fixture-high'
    await picker.getByRole('option', { name: provider === 'claude' ? /^Sonnet/ : /^Gemini Fixture/ }).click()
    await expect(input).toHaveValue('')
    await input.fill('/model default')
    await input.press('Enter')
    await expect(page.getByRole('button', { name: 'Default Model', exact: true })).toBeVisible()
    await input.fill(`/model ${name}`)
    await input.press('Enter')
    await expect(page.getByRole('button', { name: `${name} Model`, exact: true })).toBeVisible()
    await expect(input).toHaveValue('')
    expect(fixture.operations.some(message => ['session-start', 'chat-create', 'chat-config-set', 'chat-command'].includes(message.op))).toBe(false)
    await input.fill('Use the chosen model')
    await input.press('Enter')
    await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
    expect(fixture.operations.find(message => message.op === 'session-start')?.args).toMatchObject({ provider, profile: 'work', model: id, prompt: 'Use the chosen model' })
    expect(fixture.errors).toEqual([])
  })

  test(`${route} default ${provider} profile offers native models without API chat and launches the selection`, async ({ page }, testInfo) => {
    if (route === 'home') await page.setViewportSize({ width: 390, height: 844 })
    await mockProviderTerminal(page)
    const catalog = terminalCatalog(provider, { backendUnavailable: true })
    catalog.profiles![0] = { ...catalog.profiles![0], id: `${provider}/default`, profile: 'default' }
    const fixture = await connect(page, { catalog, route })
    const dialog = await openChatModelSettings(page)
    const name = provider === 'claude' ? 'Sonnet' : 'Gemini Fixture (High)'
    const model = provider === 'claude' ? 'sonnet' : 'gemini-fixture-high'
    await expect(dialog.getByRole('option', { name: /^Default/ })).toBeVisible()
    await dialog.getByRole('option', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`) }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('option', { selected: true })).toHaveText(name)
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Use a custom model…', exact: true })).not.toBeVisible()
    await expect(dialog.locator('.command-model-advanced')).toHaveCount(0)
    await expect.poll(() => dialog.getByRole('button', { name: 'Done', exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect()
      const panel = button.closest('.command-model-settings-popover')!.getBoundingClientRect()
      return rect.top >= panel.top && rect.bottom <= panel.bottom && rect.bottom <= innerHeight
    })).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('native-model-settings.png') })
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByRole('button', { name: `${name} Model`, exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use this provider model')
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).press('Enter')
    await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
    expect(fixture.operations.find(message => message.op === 'models')?.args).toEqual({ provider, profile: 'default', cwd: '/workspace' })
    expect(fixture.operations.find(message => message.op === 'session-start')?.args).toMatchObject({ provider, profile: 'default', model })
    expect(fixture.operations.some(message => message.op.startsWith('backend-discovery') || message.op === 'chat-create')).toBe(false)
    expect(fixture.errors).toEqual([])
  })

  test(`${route} sends ${provider} prompts to its terminal when chat credentials are missing`, async ({ page }) => {
    const terminals = await mockProviderTerminal(page)
    const fixture = await connect(page, { catalog: terminalCatalog(provider), route })
    if (provider === 'antigravity') {
      await openComposerNotices(page)
      const status = page.getByRole('group', { name: 'Continue in terminal', exact: true })
      const toggle = status.getByRole('button', { name: /will open in Terminals/ })
      await toggle.click()
      await expect(page.locator('.command-composer-status-popover')).toContainText('You can finish sign-in and setup in the provider’s terminal.')
      await toggle.click()
    }
    const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
    const prompt = '/review Explain this project\nKeep quotes "and" `code` and $(text) intact'
    await input.fill(prompt)
    await expect(page.locator('.command-composer').getByRole('button', { name: 'Open terminal', exact: true })).toBeEnabled()
    await input.press('Enter')
    await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
    await expect.poll(() => terminals.some(message => message.op === 'attach')).toBe(true)
    const launches = fixture.operations.filter(message => message.op === 'session-start')
    expect(launches).toHaveLength(1)
    expect(launches[0].args).toMatchObject({ provider, profile: 'work', expectedAuth: null, prompt, cwd: '/workspace',
      expectedRevision: `sha256:${'a'.repeat(64)}`, suiteTools: true, resources: {} })
    expect(fixture.operations.some(message => ['chat-create', 'chat-command', 'launch'].includes(message.op))).toBe(false)
    if (provider === 'antigravity') {
      expect(fixture.operations.some(message => message.op.startsWith('claude-account') || message.op === 'agent-operation-start')).toBe(false)
      await expect(page.getByRole('dialog', { name: /Migrate/ })).toHaveCount(0)
    }
    expect(fixture.errors).toEqual([])
  })
}

for (const provider of ['claude', 'antigravity']) {
  test(`${provider} slash help and settings stay local and preserve terminal command arguments`, async ({ page }) => {
    const fixture = await connect(page, { catalog: terminalCatalog(provider) })
    const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
    await input.fill('/help')
    await input.press('Enter')
    const help = page.getByRole('dialog', { name: 'Available commands', exact: true })
    await expect(help).toContainText('Requires the provider terminal')
    await help.getByRole('button', { name: '/model', exact: true }).click()
    const picker = page.locator('.inbox-mention-popover')
    await expect(picker).toBeVisible()
    await input.press('Escape')
    await input.fill('/model')
    await input.press('Enter')
    await expect(picker).toBeVisible()
    await input.press('Escape')
    await input.fill('/settings')
    await input.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Chat settings', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await input.fill('/effort high')
    await input.press('Enter')
    const terminal = page.getByRole('dialog', { name: '/effort · Terminal', exact: true })
    await expect(terminal).toContainText('/effort high')
    await expect(terminal).toContainText('Your draft is kept.')
    await expect(terminal.getByRole('button', { name: 'Open provider terminal', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(input).toHaveValue('/effort high')
    expect(fixture.operations.some(message => message.op.startsWith('backend-discovery') || ['session-start', 'chat-create', 'chat-commands', 'chat-command'].includes(message.op))).toBe(false)
    expect(fixture.errors).toEqual([])
  })

  test(`${provider} slash terminal handoff opens a terminal and retries its original request without running a prompt`, async ({ page }) => {
    const terminals = await mockProviderTerminal(page)
    const fixture = await connect(page, { catalog: terminalCatalog(provider), terminalFailure: 'uncertain' })
    const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
    await input.fill('/model my-native-model')
    await input.press('Enter')
    await input.fill('/permissions')
    await input.press('Enter')
    const terminal = page.getByRole('dialog', { name: '/permissions · Terminal', exact: true })
    await terminal.getByRole('button', { name: 'Open provider terminal', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible()
    const original = fixture.operations.find(message => message.op === 'session-start')!.args
    expect(original).toMatchObject({ provider, profile: 'work', model: 'my-native-model' })
    expect(original).not.toHaveProperty('prompt')
    fixture.options.terminalFailure = undefined
    await page.getByRole('button', { name: 'Retry request', exact: true }).click()
    await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
    await expect.poll(() => terminals.some(message => message.op === 'attach')).toBe(true)
    expect(fixture.operations.filter(message => message.op === 'session-start').map(message => message.args)).toEqual([original, original])
    await page.getByRole('link', { name: 'Chat', exact: true }).click()
    await expect(input).toHaveValue('/permissions')
    expect(fixture.operations.some(message => ['chat-create', 'chat-send', 'chat-command'].includes(message.op))).toBe(false)
    expect(fixture.errors).toEqual([])
  })
}

for (const provider of ['claude', 'antigravity']) test(`native ${provider} model discovery can retry and return to the profile default`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog(provider), failModels: true })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Retain this prompt while choosing a model')
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('status')).toContainText('Couldn’t load models: Model discovery unavailable')
  await setCustomChatModel(page, 'my-custom-model')
  fixture.options.failModels = false
  await dialog.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect(dialog.getByRole('option', { name: provider === 'claude' ? /^Sonnet/ : /^Gemini Fixture/ })).toBeVisible()
  await expect(dialog.getByRole('option', { name: /^my-custom-model/ })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('option', { name: /^Default/ }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('option', { name: /^Default/ })).toHaveAttribute('aria-selected', 'true')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(input).toHaveValue('Retain this prompt while choosing a model')
  await input.press('Enter')
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  expect(fixture.operations.find(message => message.op === 'session-start')?.args).not.toHaveProperty('model')
  expect(fixture.operations.filter(message => message.op === 'models')).toHaveLength(2)
  expect(fixture.operations.filter(message => message.op === 'models').at(-1)?.args.refresh).toBe(true)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`${provider} shares a cached native model list across navigation and keeps it during refresh`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog(provider), delayNativeModels: true })
  const queries = () => fixture.operations.filter(message => message.op === 'models')
  await expect.poll(() => queries().length).toBe(1)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('status')).toHaveText('Loading models…')
  fixture.options.delayNativeModels = false
  fixture.finishNativeModels()
  const choice = dialog.getByRole('option', { name: provider === 'claude' ? /^Sonnet/ : /^Gemini Fixture/ })
  await expect(choice).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  const reopened = await openChatModelSettings(page)
  await expect(reopened.getByRole('status')).toHaveCount(0)
  const catalogRequests = fixture.operations.filter(message => message.op === 'catalog').length
  fixture.catalog.profiles[0].active_runs += 1
  fixture.refreshCatalog()
  await expect.poll(() => fixture.operations.filter(message => message.op === 'catalog').length).toBeGreaterThan(catalogRequests)
  expect(queries()).toHaveLength(1)
  fixture.options.failModels = true
  await reopened.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect(reopened.getByRole('status')).toContainText('Couldn’t load models: Model discovery unavailable')
  await expect(reopened.getByRole('option', { name: provider === 'claude' ? /^Sonnet/ : /^Gemini Fixture/ })).toBeVisible()
  expect(queries()).toHaveLength(2)
  fixture.options.failModels = false
  fixture.catalog.profiles[0].revision = `sha256:${'c'.repeat(64)}`
  fixture.refreshCatalog()
  await expect.poll(() => queries().length).toBe(3)
  await expect(reopened.getByRole('status')).toHaveCount(0)
  expect(fixture.errors).toEqual([])
})

test('native model lists expire lazily after five minutes without polling', async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog('antigravity') })
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('option', { name: /^Gemini Fixture/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.clock.setFixedTime(Date.now() + 6 * 60_000)
  expect(fixture.operations.filter(message => message.op === 'models')).toHaveLength(1)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(message => message.op === 'models').length).toBe(2)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`${provider} reuses native model discovery on picker open and applies custom models once`, async ({ page }, testInfo) => {
  if (provider === 'antigravity') {
    await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
    await page.setViewportSize({ width: 390, height: 844 })
  }
  const catalog = terminalCatalog(provider, { chatReady: true })
  catalog.backends![0].controls = { model: true }
  const fixture = await connect(page, { catalog })
  const queries = () => fixture.operations.filter(message => message.op === 'models')
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('option')).toHaveCount(provider === 'claude' ? 9 : 3)
  for (let count = 0; count < 2; count++) {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await openChatModelSettings(page)
  }
  const catalogRequests = fixture.operations.filter(message => message.op === 'catalog').length
  fixture.catalog.profiles[0].active_runs += 1
  fixture.refreshCatalog()
  await expect.poll(() => fixture.operations.filter(message => message.op === 'catalog').length).toBeGreaterThan(catalogRequests)
  expect(queries()).toHaveLength(1)
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await dialog.locator('.command-model-advanced > summary').click()
  await dialog.getByRole('button', { name: 'Use a custom model…', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: 'Model ID', exact: true })
  await input.pressSequentially('my-provider-model')
  expect(queries()).toHaveLength(1)
  if (provider === 'antigravity') {
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('custom-model-entry.png') })
  await input.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Use a custom model…', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Use a custom model…', exact: true }).click()
  await input.fill('my-provider-model')
  await input.press('Enter')
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await expect(dialog.getByRole('option', { name: /^my-provider-model/ })).toHaveAttribute('aria-selected', 'true')
  expect(queries()).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await openChatModelSettings(page)
  await dialog.locator('.command-model-advanced > summary').click()
  await dialog.getByRole('button', { name: 'Edit custom model…', exact: true }).click()
  await expect(input).toHaveValue('my-provider-model')
  await input.fill('discarded-model')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus()
  await page.keyboard.press('Enter')
  expect(queries()).toHaveLength(1)
  fixture.catalog.profiles[0].revision = `sha256:${'d'.repeat(64)}`
  fixture.refreshCatalog()
  await expect.poll(() => queries().length).toBe(2)
  await expect(dialog.getByRole('option', { name: /^my-provider-model/ })).toHaveAttribute('aria-selected', 'true')
  expect(fixture.operations.some(message => ['chat-create', 'session-start'].includes(message.op))).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('switching native providers discards a late model list from the previous provider', async ({ page }) => {
  const claude = terminalCatalog('claude')
  const antigravity = terminalCatalog('antigravity')
  const fixture = await connect(page, { delayNativeModels: true, catalog: {
    profiles: [...claude.profiles!, ...antigravity.profiles!], capabilities: [...claude.capabilities!, ...antigravity.capabilities!],
    backends: [...claude.backends!, ...antigravity.backends!],
  } })
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('status')).toHaveText('Loading models…')
  await expect.poll(() => fixture.operations.some(message => message.op === 'models' && message.args.provider === 'claude')).toBe(true)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  fixture.options.delayNativeModels = false
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: 'Antigravity', exact: true }).click()
  const next = await openChatModelSettings(page)
  await expect(next.getByRole('option', { name: /^Gemini Fixture/ })).toBeVisible()
  fixture.finishNativeModels()
  await expect(next.getByRole('option', { name: /^Sonnet/ })).toHaveCount(0)
  await expect(next.getByRole('option', { name: /^Gemini Fixture/ })).toBeVisible()
  expect(fixture.errors).toEqual([])
})

for (const route of ['chat', 'home'] as const) test(`${route} confirms Claude migration then opens a terminal with the retained message`, async ({ page }) => {
  const terminals = await mockProviderTerminal(page)
  const fixture = await connect(page, { route, migrationRequired: true,
    catalog: terminalCatalog('claude', { migration: true, backendMissing: true }) })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Review the code after signing in')
  await input.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Migrate Claude logins and open terminal' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('removes the old saved token copies')
  expect(fixture.operations.some(message => ['claude-account-migrate', 'session-start'].includes(message.op))).toBe(false)
  await dialog.getByRole('button', { name: 'Migrate and open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  await expect.poll(() => terminals.some(message => message.op === 'attach')).toBe(true)
  expect(fixture.operations.filter(message => message.op === 'claude-account-migrate')).toHaveLength(1)
  expect(fixture.operations.find(message => message.op === 'claude-account-migrate')?.args.confirmed).toBe(true)
  const launches = fixture.operations.filter(message => message.op === 'session-start')
  expect(launches).toHaveLength(1)
  expect(launches[0].args).toMatchObject({ provider: 'claude', profile: 'work', expectedAuth: null,
    expectedRevision: `sha256:${'b'.repeat(64)}`, prompt: 'Review the code after signing in' })
  expect(fixture.errors).toEqual([])
})

test('cancelling Claude migration keeps the draft editable and launches nothing', async ({ page }) => {
  const fixture = await connect(page, { migrationRequired: true, catalog: terminalCatalog('claude', { migration: true }) })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this draft')
  await input.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Migrate Claude logins and open terminal' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(input).toHaveValue('Keep this draft')
  await input.fill('Edited draft after cancellation')
  expect(fixture.operations.some(message => ['claude-account-migrate', 'session-start'].includes(message.op))).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('a Claude migration completed elsewhere refreshes stale launch authentication without another confirmation', async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog('claude', { migration: true }) })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Use the migrated profile')
  Object.assign(fixture.catalog.profiles[0], { auth: null, revision: `sha256:${'b'.repeat(64)}`,
    readiness: { ...fixture.catalog.profiles[0].readiness, terminal: { ready: true, available: true, signInRequired: true } } })
  await input.press('Enter')
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  expect(fixture.operations.some(message => message.op === 'claude-account-migrate')).toBe(false)
  expect(fixture.operations.find(message => message.op === 'session-start')?.args).toMatchObject({ expectedAuth: null,
    expectedRevision: `sha256:${'b'.repeat(64)}`, prompt: 'Use the migrated profile' })
  expect(fixture.errors).toEqual([])
})

test('Claude migration failures keep the message and allow migration to be retried before launching', async ({ page }) => {
  await mockProviderTerminal(page)
  // An older catalog may say the terminal is ready: the launch preflight must still check migration.
  const fixture = await connect(page, { migrationRequired: true, migrationFailure: true, catalog: terminalCatalog() })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Continue after stopping the old session')
  await openComposerNotices(page)
  await page.getByRole('group', { name: 'Continue in terminal', exact: true }).getByRole('button', { name: /will open in Terminals/ }).click()
  await page.locator('.command-composer-status-popover').getByRole('button', { name: 'Open terminal', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Migrate Claude logins and open terminal' })
  await dialog.getByRole('button', { name: 'Migrate and open terminal', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Stop active Claude sessions before migrating.')
  expect(fixture.operations.some(message => message.op === 'session-start')).toBe(false)
  await expect(input).toHaveValue('Continue after stopping the old session')
  fixture.options.migrationFailure = false
  await dialog.getByRole('button', { name: 'Migrate and open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  const migrations = fixture.operations.filter(message => message.op === 'claude-account-migrate')
  expect(migrations).toHaveLength(2)
  expect(migrations[0].args.key).not.toEqual(migrations[1].args.key)
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

test('the terminal settings action uses the native Codex profile', async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog('codex', { backendUnavailable: true }) })
  await openComposerNotices(page)
  const status = page.getByRole('group', { name: 'Continue in terminal', exact: true })
  await status.getByRole('button', { name: /Codex will open in Terminals/ }).click()
  await page.locator('.command-composer-status-popover').getByRole('button', { name: 'Open terminal', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Open terminal', exact: true })
  await expect(settings).toContainText("native login, tools, and instructions")
  await settings.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  const launches = fixture.operations.filter(message => message.op === 'session-start')
  expect(launches).toHaveLength(1)
  expect(launches[0].args).toMatchObject({ provider: 'codex', expectedAuth: null, expectedRevision: `sha256:${'a'.repeat(64)}` })
  expect(launches[0].args).not.toHaveProperty('auth')
  expect(launches[0].args).not.toHaveProperty('resources')
  expect(launches[0].args).not.toHaveProperty('suiteTools')
  expect(fixture.errors).toEqual([])
})

for (const interrupted of [true, false]) test(`Claude migration handles ${interrupted ? 'an interrupted response' : 'an unconfirmed receipt'} before opening the terminal`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { migrationRequired: true, migrationInterrupted: interrupted, migrationUnconfirmed: !interrupted,
    catalog: terminalCatalog('claude', { migration: true }) })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep the message while confirming migration')
  await input.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Migrate Claude logins and open terminal' })
  await dialog.getByRole('button', { name: 'Migrate and open terminal', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(interrupted ? 'Migration response was interrupted.' : 'migration has not completed')
  expect(fixture.operations.some(message => message.op === 'session-start')).toBe(false)
  fixture.options.migrationUnconfirmed = false
  await dialog.getByRole('button', { name: 'Migrate and open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  const migrations = fixture.operations.filter(message => message.op === 'claude-account-migrate')
  expect(migrations).toHaveLength(2)
  if (interrupted) expect(migrations[0].args.key).toEqual(migrations[1].args.key)
  else expect(migrations[0].args.key).not.toEqual(migrations[1].args.key)
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) for (const backendMissing of [true, false]) test(`${provider} terminal fallback covers ${backendMissing ? 'missing' : 'unavailable'} chat backends`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog(provider, { backendMissing, backendUnavailable: true, chatReady: true }) })
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Continue in the CLI')
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`catalog readiness can route a terminal-ready ${provider} profile to its CLI when chat credentials are missing`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog(provider, { chatReady: false }) })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Use the terminal after checking chat support')
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  expect(fixture.operations.some(message => message.op === 'backend-discovery-get')).toBe(false)
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

test('Codex profiles that only support terminals remain selectable without automatic chat selection', async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog('codex', { backendUnavailable: true }) })
  await expect(page.getByRole('button', { name: 'work Profile', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Start a Codex terminal')
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  expect(fixture.operations.find(message => message.op === 'session-start')?.args.profile).toBe('work')
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`${provider} terminal fallback preserves the draft and retries the original launch after an interrupted response`, async ({ page }) => {
  await mockProviderTerminal(page)
  const fixture = await connect(page, { catalog: terminalCatalog(provider), terminalFailure: 'uncertain' })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this prompt until launch is confirmed')
  await input.press('Enter')
  await expect(input).toHaveValue('Keep this prompt until launch is confirmed')
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeEnabled()
  fixture.options.terminalFailure = undefined
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/provider-terminal$/)
  const launches = fixture.operations.filter(message => message.op === 'session-start')
  expect(launches).toHaveLength(2)
  expect(launches[1].args).toEqual(launches[0].args)
  await page.goto('/#/chat')
  await expect(input).toHaveValue('')
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`a rejected ${provider} terminal launch leaves the prompt editable`, async ({ page }) => {
  const fixture = await connect(page, { catalog: terminalCatalog(provider), terminalFailure: 'validation' })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Fix the selected project')
  await input.press('Enter')
  await expect(input).toBeEditable()
  await expect(input).toHaveValue('Fix the selected project')
  await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toBeEnabled()
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

test('each error or setup row opens only its own details and actions', async ({ page }) => {
  const fixture = await connect(page, { catalog: terminalCatalog('antigravity'), terminalFailure: 'validation' })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep the prompt while inspecting each notice')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '2 issues', exact: true })).toBeVisible()
  await expect(page.locator('.command-composer-status-trigger')).toHaveCount(0)
  await openComposerNotices(page)
  const rows = page.locator('.command-composer-status-trigger')
  await expect(rows).toHaveCount(2)
  await page.getByRole('button', { name: 'Selected project is unavailable', exact: true }).click()
  const popover = page.locator('.command-composer-status-popover')
  await expect(popover).toHaveCount(1)
  await expect(popover.getByRole('button', { name: 'Check status', exact: true })).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Configure chat credentials', exact: true })).toHaveCount(0)
  await openComposerNotices(page)
  await page.getByRole('group', { name: 'Continue in terminal', exact: true }).getByRole('button', { name: /will open in Terminals/ }).click()
  await expect(popover).toHaveCount(1)
  await expect(popover.getByRole('dialog', { name: 'Continue in terminal', exact: true })).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Configure chat credentials', exact: true })).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Check status', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Keep the prompt while inspecting each notice')
  expect(fixture.operations.filter(message => message.op === 'session-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['claude', 'antigravity']) test(`a completed ${provider} terminal launch respects navigation away from the composer`, async ({ page }) => {
  const fixture = await connect(page, { catalog: terminalCatalog(provider), delayTerminalLaunch: true })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Launch in the background')
  await input.press('Enter')
  await expect.poll(() => fixture.operations.some(message => message.op === 'session-start')).toBe(true)
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Workflows', exact: true }).click()
  fixture.finishTerminal()
  await expect(page).toHaveURL(/#\/workflows/)
  expect(fixture.errors).toEqual([])
})

test('profiles with unavailable terminals keep setup blocking submission', async ({ page }) => {
  const fixture = await connect(page, { catalog: terminalCatalog('claude', { terminalReady: false }) })
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Wait until setup is ready')
  await expect(page.getByRole('button', { name: 'Open terminal', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  expect(fixture.operations.some(message => message.op === 'session-start')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('providers include terminal-ready profiles and SDK-only chat installations', async ({ page }) => {
  const fixture = await connect(page, { catalog: {
    profiles: [
      { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0, readiness: { ready: false } },
      { id: 'claude/work', provider: 'claude', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
      { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, active_runs: 0, readiness: { ready: false } },
      { id: 'antigravity/work', provider: 'antigravity', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
      { id: 'copilot/work', provider: 'copilot', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
    ],
    capabilities: ['codex', 'claude', 'opencode', 'antigravity', 'copilot'].map(provider => ({
      provider, installed: !['codex', 'antigravity'].includes(provider), savedModels: false, budgets: false,
      ...(provider === 'copilot' ? { label: 'GitHub Copilot' } : {}),
    })),
    backends: [
      { id: 'native-codex', provider: 'codex', label: 'Codex', available: false, controls: {} },
      { id: 'claude-sdk', provider: 'claude', label: 'Claude SDK', available: false, controls: {} },
      { id: 'opencode-acp', provider: 'opencode', label: 'OpenCode', available: true, controls: {} },
      { id: 'antigravity-sdk', provider: 'antigravity', label: 'Antigravity SDK', available: true, controls: {} },
    ],
  }, carrierProfiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work' },
    { id: 'claude/work', provider: 'claude', profile: 'work' },
    { id: 'codex/stale', provider: 'codex', profile: 'stale' },
  ] })
  await expect(page.getByRole('button', { name: 'Claude Provider', exact: true })).toBeVisible()
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option')).toHaveText(['Claude', 'Antigravity', 'GitHub Copilot'])
  await page.getByRole('option', { name: 'Antigravity', exact: true }).click()
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option', { name: 'work (antigravity/work) antigravity profile', exact: true })).toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('unavailable installations and accounts show an empty selector and provider setup', async ({ page }) => {
  const fixture = await connect(page, { catalog: {
    profiles: [
      { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
      { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, active_runs: 0, readiness: { ready: false } },
    ],
    capabilities: [
      { provider: 'codex', installed: false, savedModels: false, budgets: false },
      { provider: 'opencode', installed: true, savedModels: false, budgets: false },
    ],
  } })
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'No profiles available Profile', exact: true })).toBeDisabled()
  await openComposerNotices(page)
  await expect(page.getByRole('group', { name: 'Agent setup required' })).toContainText('No providers are ready for chat.')
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my draft until setup is ready')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  expect(fixture.operations.some(message => message.op === 'chat-create' || message.op === 'launch')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('catalog updates remove unavailable selections without losing the draft and restore newly ready providers', async ({ page }) => {
  const fixture = await connect(page)
  await chooseAgent(page, 'work')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep these instructions')
  fixture.catalog.profiles[0].readiness = { ready: false }
  fixture.catalog.profiles[1].readiness = { ready: false }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'OpenCode Provider', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Keep these instructions')
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option')).toHaveText(['OpenCode'])
  await page.keyboard.press('Escape')
  fixture.catalog.profiles[2].readiness = { ready: false }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  fixture.catalog.profiles[0].readiness = { ready: true }
  await openComposerNotices(page)
  await page.locator('.command-composer-status-trigger').click()
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Codex Provider', exact: true })).toBeVisible()
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.getByRole('option', { name: 'Auto Codex · highest available budget · selected at launch', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'work codex profile', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Keep these instructions')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  expect(fixture.errors).toEqual([])
})

test('model choices follow the profile, preserve instructions, and ignore an older profile response', async ({ page }) => {
  const fixture = await connect(page, { delayReview: true })
  const picker = page.getByRole('button', { name: / Model$/ })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep my instructions')
  await chooseAgent(page, 'work')
  await expect(picker).toBeEnabled()
  await picker.click()
  await page.getByRole('option', { name: /^work Fast/ }).click()
  await expect(page.getByRole('option', { name: /^work Fast/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('dialog', { name: 'Choose model', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose model', exact: true })).not.toBeVisible()
  await expect(picker).toContainText('work Fast')
  await chooseAgent(page, 'review')
  await expect(picker).toContainText('Default')
  await expect.poll(() => fixture.operations.filter((message) => message.op === 'backend-discovery-get' && message.args.profile === 'review').length).toBe(1)
  const reviewModels = await openChatModelSettings(page)
  await expect(reviewModels.getByRole('option', { name: /^work Fast/ })).toHaveCount(0)
  await expect(reviewModels.getByRole('option', { name: /^Default/ })).toHaveAttribute('aria-selected', 'true')
  await reviewModels.getByRole('button', { name: 'Done', exact: true }).click()
  await chooseAgent(page, 'local')
  await expect(picker).toBeEnabled()
  fixture.finishReview()
  await picker.click()
  await expect(page.getByRole('option', { name: /^Default/ })).toHaveText('Default')
  await expect(page.getByRole('option', { name: /^review Fast/ })).toHaveCount(0)
  await page.getByRole('option', { name: /^OpenCode Free/ }).click()
  await expect(page.getByRole('option', { name: /^OpenCode Free/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('dialog', { name: 'Choose model', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose model', exact: true })).not.toBeVisible()
  await expect(input).toHaveValue('Keep my instructions')
  expect(fixture.operations.filter((message) => message.op === 'backend-discovery-get').at(-1)?.args).toMatchObject({ provider: 'opencode', profile: 'local', backend: 'opencode-native' })
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-create')?.args.model).toBe('fixture/free')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await chooseAgent(page, 'work')
  await expect(picker).toBeEnabled()
  await expect(picker).toContainText('Default')
  expect(fixture.errors).toEqual([])
})

test('model discovery errors can be retried and profile default omits the override', async ({ page }) => {
  const fixture = await connect(page, { failModels: true })
  await chooseAgent(page, 'work')
  const picker = page.getByRole('button', { name: / Model$/ })
  await picker.click()
  await expect(page.getByRole('status').filter({ hasText: 'Couldn’t load models: Model discovery unavailable' })).toBeVisible()
  const requests = fixture.operations.filter(message => message.op === 'backend-discovery-get')
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) expect(request.args).toEqual({ provider: 'codex', profile: 'work', backend: 'native-codex',
    draftId: expect.any(String) })
  expect(fixture.operations.some(message => message.op === 'models')).toBe(false)
  fixture.options.failModels = false
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(message => message.op === 'backend-discovery-refresh').map(message => message.args)).toEqual([
    { ...requests.at(-1)!.args, key: expect.any(String) },
  ])
  await expect(page.getByRole('option', { name: /^work Fast/ })).toBeVisible()
  await page.getByRole('option', { name: /^Default/ }).click()
  await expect(page.getByRole('option', { name: /^Default/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('dialog', { name: 'Choose model', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Choose model', exact: true })).not.toBeVisible()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Hello')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.filter((message) => message.op === 'chat-create').length).toBe(1)
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('model')
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('cwd')
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('projectId')
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  await expect(picker).toBeDisabled()
  expect(fixture.errors).toEqual([])
})

for (const scenario of [
  { name: 'desktop', theme: 'light', width: 1440, height: 1000 },
  { name: 'mobile', theme: 'dark', width: 390, height: 844 },
]) test(`model tooltip stays anchored until dismissed on ${scenario.name}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), scenario.theme)
  await page.setViewportSize({ width: scenario.width, height: scenario.height })
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const fixture = await connect(page)
  const picker = page.getByRole('button', { name: 'Default Model', exact: true })
  await expect(picker).toBeEnabled()
  await page.mouse.move(200, 300)
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.hover()
    const tooltip = page.getByRole('tooltip', { name: 'Model: Default', exact: true })
    await expect(tooltip).toBeVisible()
    const trigger = (await picker.boundingBox())!
    const observation = page.evaluate(async () => {
      const samples: { x: number; y: number; width: number; height: number; placement: string | null; source: string }[] = []
      const record = (source: string) => {
        for (const element of document.querySelectorAll<HTMLElement>('.command-picker-tooltip')) {
          const style = getComputedStyle(element)
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
          const box = element.getBoundingClientRect()
          samples.push({ x: box.x, y: box.y, width: box.width, height: box.height, placement: element.getAttribute('data-placement'), source })
        }
      }
      const observer = new MutationObserver(() => record('mutation'))
      record('initial')
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-placement', 'data-exiting'] })
      await new Promise<void>(resolve => {
        const until = performance.now() + 1000
        const frame = () => {
          record('frame')
          if (performance.now() < until) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      observer.disconnect()
      return samples
    })
    await page.mouse.move(200, 300)
    await expect(tooltip).toHaveCount(0)
    const samples = await observation
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.filter(box => box.x + box.width < trigger.x || box.x > trigger.x + trigger.width ||
      Math.min(Math.abs(box.y + box.height - trigger.y), Math.abs(box.y - trigger.y - trigger.height)) > 24)).toEqual([])
  }
  expect(fixture.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`model picker is accessible on mobile in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await connect(page)
    const picker = page.getByRole('button', { name: / Model$/ })
    await expect(picker).toBeEnabled()
    await picker.click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/command-models/${theme}-mobile.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(picker).toBeFocused()
    await openChatModelSettings(page)
    const settings = page.getByRole('button', { name: 'Chat settings', exact: true })
    await settings.click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-composer/${theme}-settings-mobile.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(settings).toBeFocused()
  })
}


test('new chats use the preferred profile and keep it selected when its account needs attention', async ({ page }) => {
  const fixture = await connect(page, { catalog: { profiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0, readiness: { ready: true } },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0,
      preferred: true, readiness: { ready: true, chat: { ready: true } } },
  ] } })
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep the selected account')
  fixture.catalog.profiles[1].readiness = { ready: false, chat: { ready: false, reason: 'Sign-in required' }, terminal: { ready: false } }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  await openComposerNotices(page)
  await expect(page.getByText('Sign-in required', { exact: true })).toBeVisible()
  expect(fixture.operations.some(row => row.op === 'chat-create')).toBe(false)
  fixture.catalog.profiles[1].readiness = { ready: true, chat: { ready: true } }
  fixture.refreshCatalog()
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find(row => row.op === 'chat-create')?.args.profile).toBe('review')
  expect(fixture.errors).toEqual([])
})


test('compact composer keeps one row and shows provider and profile below the input', async ({ page }) => {
  const fixture = await connect(page)
  const composer = page.locator('.command-composer')
  const add = composer.getByRole('button', { name: 'Add context and tools', exact: true })
  const input = composer.getByRole('textbox', { name: 'Instructions', exact: true })
  const model = composer.getByRole('button', { name: / Model$/ })
  const send = composer.locator('.command-send')
  await expect(composer.getByRole('button', { name: / Provider$/ })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: / Profile$/ })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Selected context', exact: true })).toBeVisible()
  await expect(page.locator('.command-composer-identity').getByRole('button', { name: / Provider$/ })).toBeVisible()
  await expect(page.locator('.command-composer-identity').getByRole('button', { name: / Profile$/ })).toBeVisible()
  await expect(model).toHaveText('Default')
  await page.locator('.command-composer-identity').getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option', { name: 'OpenCode', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.command-composer-identity').getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option', { name: /review/ })).toBeVisible()
  await page.keyboard.press('Escape')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const bounds = await Promise.all([add, input, model, send].map(control => control.boundingBox()))
    expect(bounds.every(Boolean)).toBe(true)
    const boxes = bounds.map(box => box!)
    const centers = boxes.map(box => box.y + box.height / 2)
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4)
    for (let index = 1; index < boxes.length; index++) {
      expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width)
    }
    expect(boxes.at(-1)!.x + boxes.at(-1)!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: test.info().outputPath(`compact-composer-${width}.png`) })
    for (const text of ['First line\nSecond line', 'This message has enough words to wrap onto more than one line at every tested screen width. '.repeat(5), 'Long line\n'.repeat(30)]) {
      await input.fill(text)
      await expect(composer.locator('.command-composer-row')).toHaveAttribute('data-multiline', 'true')
      await expect.poll(() => composer.evaluate(element => element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true)
      await expect.poll(async () => {
        const bounds = await Promise.all([add, model, send].map(control => control.boundingBox()))
        const field = await input.boundingBox()
        if (!field || bounds.some(box => !box)) return Infinity
        const buttons = bounds.map(box => box!)
        expect(field.y + field.height).toBeLessThanOrEqual(Math.min(...buttons.map(box => box.y)))
        expect(Math.abs(field.x - buttons[0].x)).toBeLessThan(2)
        expect(Math.abs(field.x + field.width - (buttons[2].x + buttons[2].width))).toBeLessThan(2)
        const bottoms = buttons.map(box => box.y + box.height)
        return Math.max(...bottoms) - Math.min(...bottoms)
      }).toBeLessThan(2)
    }
    expect(await input.evaluate(field => field.scrollHeight > field.clientHeight)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`multiline-composer-${width}.png`) })
    await input.fill('')
    await expect(composer.locator('.command-composer-row')).not.toHaveAttribute('data-multiline', 'true')
    await expect.poll(() => composer.evaluate(element => element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true)

  }
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openChatModelSettings(page)
  await expect(dialog.getByRole('button', { name: 'Refresh models', exact: true })).toHaveText('')
  await dialog.getByRole('button', { name: 'Refresh models', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(operation => operation.op === 'backend-discovery-refresh').length).toBeGreaterThan(0)
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)
  await expect(dialog.locator('.command-model-advanced')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: / Provider$/ })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: / Profile$/ })).toHaveCount(0)
  await expect(dialog.getByRole('option', { name: /^Default/ })).toContainText('Use the profile’s model')
  await page.screenshot({ path: test.info().outputPath('model-controls.png') })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox()
      return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 844)
    }).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`model-controls-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  await dialog.getByRole('option', { name: /^work Fast/ }).click()
  await expect(dialog).not.toBeVisible()
  await expect(model).toHaveText('work Fast')
  await openChatModelSettings(page)
  await dialog.getByRole('button', { name: 'Chat settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Chat settings', exact: true })).toBeVisible()
  await expect(dialog).not.toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('starting a project draft does not turn unknown provider defaults into overrides', async ({ page }) => {
  const fixture = await connect(page, { unknownDraftSetting: true })
  await expect.poll(() => fixture.operations.some(message => message.op === 'backend-discovery-get')).toBe(true)
  await page.getByRole('button', { name: 'Sample, 0 conversations', exact: true }).click()
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Hello from the project')
  await expect(page.getByText('Some draft settings are unavailable.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find(message => message.op === 'chat-create')?.args).toBeTruthy()
  expect(fixture.operations.find(message => message.op === 'chat-create')?.args.initialConfig ?? []).toEqual([])
  expect(fixture.errors).toEqual([])
})

test('new projects browse folders and fill the path and suggested name', async ({ page }) => {
  await page.route('**/api/filesystem/locations', route => route.fulfill({ json: {
    initial: '/workspace', locations: [{ id: 'home', name: 'Home', path: '/workspace' }],
  } }))
  await page.route('**/api/filesystem/directories?**', route => {
    const path = new URL(route.request().url()).searchParams.get('path')!
    return route.fulfill({ json: { path, name: path === '/workspace' ? 'workspace' : 'sample', parent: path === '/workspace' ? null : '/workspace',
      breadcrumbs: [{ name: 'workspace', path: '/workspace' }], entries: path === '/workspace' ? [{ name: 'sample', path: '/workspace/sample' }] : [],
      total: path === '/workspace' ? 1 : 0, nextCursor: null } })
  })
  await connect(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByRole('button', { name: 'Browse folders', exact: true }).click()
  await dialog.getByRole('button', { name: 'Open folder sample', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use this folder', exact: true }).click()
  await expect(dialog.getByLabel('Project path', { exact: true })).toHaveValue('/workspace/sample')
  await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('sample')
  await expect(dialog.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled()
})

test('Ctrl+N starts a fresh conversation from the focused chat composer', async ({ page }) => {
  await connect(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Previous draft')
  await input.press('Control+n')
  await expect(page).toHaveURL(/#\/chat$/)
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
})

test('sending with Enter or the send button returns focus to the chat input', async ({ page }) => {
  const fixture = await connect(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await input.fill('First message')
  await input.press('Enter')
  await expect.poll(() => fixture.operations.some(message => message.op === 'chat-send')).toBe(true)
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await input.fill('Follow-up message')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
})
