import { test, expect, openChatSettings, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
const digest = 'sha256:' + 'a'.repeat(64)
const changed = 'sha256:' + 'b'.repeat(64)
const chatId = '66d32312-73df-457d-bd2c-96a5a7e7474a'
const entry = { id: digest, name: 'audit', source_id: 'first', path: '/fixture/skills/audit', editable: true, status: 'valid', digest,
  manifest: { directories: ['refs'], files: [{ path: 'SKILL.md', size: 30, executable: false, digest }, { path: 'refs/bytes.bin', size: 3, executable: false, digest }] } }
const skillCatalog = { store: '/fixture/store', store_id: digest, sources: [{ id: 'first', paths: ['/fixture/skills'], writable: true, revision: digest }],
  entries: [entry, { ...entry, id: changed, source_id: 'second', editable: false }], releases: [{ reference: 'first/audit@1', source_id: 'first', name: 'audit', version: '1', digest }] }
const catalog = { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0, mcp: { servers: [], revision: digest } }], auths: [], capabilities: [{ provider: 'codex', installed: true, savedModels: false, budgets: false }], cwd: '/fixture',
  backends: [{ id: 'native-codex', provider: 'codex', label: 'Native Codex · managed sessions', available: true, controls: { model: true, access: true, instructions: true, skills: true } },
    { id: 'codex-acp', provider: 'codex', label: 'Codex ACP', available: true, controls: { model: false, access: false, instructions: false, skills: false } }] }
async function fixture(page: Page, options: { waiting?: boolean; conflict?: boolean; unavailable?: string; existingProvider?: string; assigned?: boolean; mcpConflict?: boolean; preserveResources?: boolean; crlf?: boolean } = {}) {
  const writes: { op: string; args: Record<string, unknown> }[] = []
  const providerCatalog = JSON.parse(JSON.stringify(catalog))
  for (const provider of ['claude', 'antigravity']) {
    providerCatalog.profiles.push({ id: `${provider}/work`, provider, profile: 'work', auth: null, active_runs: 0, ...(provider === 'claude' ? { claude_account: { id: 'test-account', name: 'Work' } } : {}), mcp: { servers: [], revision: digest } })
    providerCatalog.capabilities.push({ provider, installed: true, savedModels: false, budgets: false, authMode: 'native', savedAuth: false })
    providerCatalog.backends.push({ id: provider === 'antigravity' ? 'antigravity-sdk' : `${provider}-acp`, provider,
      label: provider === 'claude' ? 'Claude' : 'Antigravity SDK', default: true,
      available: provider !== options.unavailable, reason: provider === options.unavailable ? 'Install the configured agent adapter.' : undefined,
      controls: { model: false, access: false, instructions: false, skills: false } })
  }
  if (options.assigned) providerCatalog.profiles[0].mcp.servers = ['sonar']
  const definitions: Record<string, Record<string, unknown>> = options.assigned ? { sonar: { name: 'sonar', installed: true, kind: 'stdio', command: 'sonar', revision: digest } } : {}
  const skillState = structuredClone(skillCatalog)
  const resourceDefaults = new Map<string, { revision: string; instructions: unknown; skills: unknown[]; mcp: unknown[] }>()
  const defaults = (provider: string, profile: string) => {
    const key = `${provider}/${profile}`
    if (!resourceDefaults.has(key)) resourceDefaults.set(key, { revision: digest,
      instructions: options.assigned && provider === 'codex' ? { target: 'review@1/instructions', required: false, inputs: {} } : null,
      skills: options.assigned && provider === 'codex' ? [{ target: { kind: 'release', store: '/fixture/store', reference: 'first/audit@1' }, required: !!options.preserveResources }, ...(options.preserveResources ? [{ target: { kind: 'release', store: '/other/store', reference: 'other/research@3' }, required: false }] : [])] : [],
      mcp: options.assigned && provider === 'codex' ? [{ target: 'sonar', required: false }] : [],
    })
    return resourceDefaults.get(key)!
  }
  let applications: { id: string; label: string; revision: string; prompts: Record<string, unknown> }[] = [{ id: 'pathspec', label: 'Pathspec', revision: digest, prompts: { review: { kind: 'release', reference: 'recipe@1/review' } } }]
  let edited = false
  const snapshot = { id: chatId, provider: 'codex', profile: 'work', auth: null, backend: 'codex-acp', backendRoute: 'managed', resourceSnapshotRef: digest,
    title: 'Managed fixture', cwd: '/fixture/chat', project: '', mode: 'chat', createdAt: Date.now(), updatedAt: Date.now(), revision: 1,
    status: options.waiting ? 'waiting' : 'ready', turnId: 'opaque-turn', items: [], requests: options.waiting ? [{ requestId: 'e'.repeat(32), method: 'server-manager/request', params: { kind: 'permission', message: 'Allow access?', choices: [{ optionId: 'allow:once', name: 'Allow once' }, { optionId: 'reject:once', name: 'Reject once' }] } }] : [],
    launches: [], workflows: [], discoveries: [], transfers: [] }
  let current = { ...snapshot, ...(options.existingProvider ? { provider: options.existingProvider, backend: `${options.existingProvider}-acp`, model: 'fixture-one',
    sessionConfig: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fixture-one', options: [
      { value: 'fixture-one', name: 'Fixture One' }, { value: 'fixture-two', name: 'Fixture Two' }] }] } : {}) }
  await page.routeWebSocket('**/api/carrier/ws', socket => { socket.send(JSON.stringify({ type: 'ready' })); socket.onMessage(raw => {
    const { id, op } = JSON.parse(String(raw)); socket.send(JSON.stringify({ type: 'result', id, result: op === 'service' ? { connected: false, providers: [], agent_configured: false } : [] }))
  }) })
  await page.routeWebSocket('**/api/agents/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw)); const { id, op, args } = request; writes.push(request)
      if ((op === 'skills-save' || op === 'skills-profile-set' || op === 'prompts-application-set' || op === 'profile-resources-set') && options.conflict || op === 'mcp-configure' && options.mcpConflict) {
        socket.send(JSON.stringify({ type: 'error', id, code: 'conflict', message: 'Resource changed; refresh before saving' })); return
      }
      let result: unknown = []
      if (op === 'claude-accounts') result = { accounts: [{ id: 'test-account', name: 'Work', directory: '/fixture/claude', owned: true, profiles: ['work'], status: { state: 'sign-in-required', checkedAt: Date.now() } }], migrationRequired: false }
      else if (op === 'agent-profile-get') result = { revision: digest }
      else if (op === 'catalog') result = providerCatalog
      else if (op === 'resource-catalog') result = { choices: {
        instructions: [{ label: 'review@1/instructions', target: 'review@1/instructions' }],
        skills: [{ label: 'first/audit@1 · /fixture/store', target: { kind: 'release', store: '/fixture/store', reference: 'first/audit@1' } }],
        mcp: Object.keys(definitions).map(name => ({ label: name, target: name })),
      } }
      else if (op === 'profile-resources-get') result = defaults(args.provider, args.profile)
      else if (op === 'profile-resources-set') {
        expect(args.expectedRevision).toBe(defaults(args.provider, args.profile).revision)
        result = { ...args.resources, revision: changed }
        resourceDefaults.set(`${args.provider}/${args.profile}`, result as ReturnType<typeof defaults>)
      }
      else if (op === 'launch-preview') result = { report: { items: [] } }
      else if (op === 'agent-operation-start') result = { ...args, id: args.key, status: 'running', createdAt: Date.now() }
      else if (op === 'agent-operations') result = { operations: [] }
      else if (op === 'sessions') result = { runs: [], runtimeError: null }
      else if (op === 'session-list') result = { sessions: [], total: 0, homes: [], projects: [], counts: {}, errors: [] }
      else if (op === 'spawn-settings-get') result = { defaultMode: 'full-access', revision: 0 }
      else if (op === 'project-discovery-list') result = { jobs: [], nextOffset: null }
      else if (op === 'chat-list') result = options.waiting || options.existingProvider ? [current] : []
      else if (op === 'chat-create') {
        current = { ...current, id: args.key, provider: args.provider ?? 'codex', backend: args.backend ?? 'native-codex' }
        result = current
      }
      else if (op === 'chat-open' || op === 'chat-send') result = { ...current, id: args.chatId ?? chatId }
      else if (op === 'chat-config-set') {
        current = { ...current, revision: current.revision + 1, model: args.value, sessionConfig: current.sessionConfig?.map(row => ({ ...row, currentValue: args.value })) }
        result = current
      }
      else if (op === 'mcp-catalog') result = { servers: Object.values(definitions), live_updates: false }
      else if (op === 'mcp-show') result = definitions[args.name]
      else if (op === 'mcp-configure') { result = { name: args.name, installed: true, ...args.definition, revision: changed }; definitions[args.name] = result as Record<string, unknown> }
      else if (op === 'mcp-chat-status') result = { servers: [], capabilities: { reconnect: false, preserve_selection: false, reconnect_scopes: [] }, selection: { selection_digest: digest } }
      else if (op === 'skills-catalog') result = skillState
      else if (op === 'skills-show') result = { ...entry, editable: args.entryId !== changed, source_id: args.entryId === changed ? 'second' : 'first', digest: edited ? changed : digest }
      else if (op === 'skills-file') result = { content_b64: args.file === 'refs/bytes.bin' ? 'AP8B' : Buffer.from(options.crlf ? '---\r\nname: audit\r\ndescription: Fixture\r\n---\r\nOriginal instructions' : '---\nname: audit\ndescription: Fixture\n---\nOriginal instructions').toString('base64') }
      else if (op === 'skills-save') { edited = true; result = { ...entry, digest: changed } }
      else if (op === 'skills-create') result = entry
      else if (op === 'skills-validate') result = { valid: true, files: 2 }
      else if (op === 'skills-release') { result = { ...skillCatalog.releases[0], version: args.version, reference: `first/audit@${args.version}` }; skillState.releases.push(result as typeof skillCatalog.releases[number]) }
      else if (op === 'skills-profile-get') result = { skills: options.assigned ? [{ store: args.provider === 'codex' ? '/fixture/store' : '/another/store', reference: 'first/audit@1' }] : [], revision: digest }
      else if (op === 'skills-profile-set') result = { skills: args.skills, revision: changed }
      else if (op === 'prompts-catalog') result = { store: '/fixture/prompts', checked_at: new Date().toISOString(), packs: options.assigned ? [{ id: 'prompt-release', kind: 'release', name: 'review', source: 'Fixture', source_id: 'first', version: '1', digest, reference: 'review@1', status: 'available', prompts: [{ name: 'instructions', description: 'Review changes', inputs: {}, instruction_compatible: true }] }] : [], consumers: options.assigned ? [{ id: 'local-codex', label: 'Local Codex', provider: 'codex', local: true, status: 'available', profiles: [{ profile: 'work', binding: { reference: 'review@1/instructions', inputs: {} }, binding_digest: digest }], launches: [] }] : [], sources: [], sourceRegistrations: [{ id: 'exact', label: 'Local drafts', paths: ['/fixture/prompts'], revision: digest, writable: true }], applications }
      else if (op === 'prompts-show') result = { entry: { id: 'prompt-release' }, release: { digest }, manifest: {}, files: { 'instructions.md': 'Review these changes carefully.' }, dependencies: {} }
      else if (op === 'prompts-application-register') {
        const app = { id: args.applicationId, label: args.label, revision: digest, prompts: args.prompts }; applications.push(app); result = app
      }
      else if (op === 'prompts-application-set') {
        applications = applications.map(app => app.id === args.applicationId ? { ...app, revision: changed, prompts: { ...app.prompts, [args.logicalPrompt]: args.target } } : app)
        result = applications.find(app => app.id === args.applicationId)
      }
      else if (op === 'prompts-application-resolve') result = { source_id: 'exact', reference: 'recipe@1/review', release: { digest }, used_fallback: false }
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return writes
}
test('Skills retain source identity, binary bytes, executable flags and observed digests', async ({ page }) => {
  const writes = await fixture(page)
  await page.goto('/#/skills')
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await page.getByRole('button', { name: /SKILL.md/ }).click()
  await page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('menuitem', { name: 'refs/bytes.bin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
  await page.locator('.resource-editor').getByRole('button', { name: 'File settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Executable file', exact: true }).focus(); await page.keyboard.press('Space')
  await page.keyboard.press('Escape')
  await page.locator('.resource-editor').getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => writes.filter(row => row.op === 'skills-save').length).toBe(1)
  expect(writes.find(row => row.op === 'skills-save')?.args).toMatchObject({ entryId: digest, file: 'refs/bytes.bin', content_b64: 'AP8B', executable: true, expectedDigest: digest })
  await page.getByRole('button', { name: 'audit · second', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit skill', exact: true })).toHaveCount(0)
})
test('stale skill saves keep the edited content and report a conflict', async ({ page }) => {
  await fixture(page, { conflict: true })
  await page.goto('/#/skills'); await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
  await page.getByRole('textbox', { name: 'Skill file contents', exact: true }).fill('Unsaved author work')
  await page.locator('.resource-editor').getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.resource-editor').getByRole('alert')).toContainText('Resource changed')
  await expect(page.getByRole('textbox', { name: 'Skill file contents', exact: true })).toHaveText('Unsaved author work')
})
async function openIntegrations(page: Page) {
  await page.goto('/#/agents/prompts')
  await page.getByRole('button', { name: 'Prompts menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'App integrations', exact: true }).click()
}

test('prompt integrations edit mappings using observed revisions and inspect resolution separately', async ({ page }) => {
  const writes = await fixture(page, { assigned: true })
  await openIntegrations(page)
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Connected apps', exact: true })).toContainText('1 prompt mapping')
  await page.getByRole('button', { name: 'Manage Pathspec', exact: true }).click()
  await page.getByRole('button', { name: 'Edit mapping review', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit prompt mapping', exact: true })
  await expect(editor.getByLabel('Prompt name in app', { exact: true })).toHaveValue('review')
  await expect(editor.getByRole('combobox', { name: 'Released prompt', exact: true })).toHaveValue('recipe@1/review')
  await editor.getByRole('combobox', { name: 'Released prompt', exact: true }).fill('review')
  await page.getByRole('option', { name: 'review@1/instructions', exact: true }).click()
  await editor.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(writes.find(row => row.op === 'prompts-application-set')?.args).toMatchObject({ applicationId: 'pathspec', logicalPrompt: 'review', expectedRevision: digest, target: { kind: 'release', reference: 'review@1/instructions' } })
  const inspect = page.getByRole('button', { name: 'Inspect mapping review', exact: true })
  await inspect.click()
  const resolution = page.getByRole('dialog', { name: 'Resolved prompt', exact: true })
  await expect(resolution).toContainText('recipe@1/review')
  await expect(resolution).toContainText('exact')
  await expect(resolution.getByLabel('Prompt resolution details')).toBeHidden()
  await resolution.getByText('Technical details', { exact: true }).click()
  await expect(resolution.getByLabel('Prompt resolution details')).toContainText('source_id')
  await resolution.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(inspect).toBeFocused()
})

for (const theme of ['light', 'dark']) test(`prompt integrations connect apps and configure mappings in compact dialogs in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const writes = await fixture(page)
  await openIntegrations(page)
  await page.screenshot({ path: test.info().outputPath(`integrations-${theme}.png`) })
  await page.getByRole('button', { name: 'Connect app', exact: true }).click()
  const connect = page.getByRole('dialog', { name: 'Connect app', exact: true })
  await connect.getByLabel('App name', { exact: true }).fill('Documentation')
  await connect.getByLabel('Application ID', { exact: true }).fill('docs')
  await connect.getByRole('button', { name: 'Connect app', exact: true }).click()
  await expect(connect).toBeHidden()
  expect(writes.find(row => row.op === 'prompts-application-register')?.args).toMatchObject({ applicationId: 'docs', label: 'Documentation', prompts: {}, expectedRevision: null })
  await expect(page.getByRole('heading', { name: 'No prompt mappings yet', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add mapping', exact: true }).click()
  const mapping = page.getByRole('dialog', { name: 'Add prompt mapping', exact: true })
  await mapping.getByLabel('Prompt name in app', { exact: true }).fill('code_review')
  await mapping.getByLabel('Released prompt', { exact: true }).fill('recipe@2/review')
  await mapping.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(mapping).toBeHidden()
  expect(writes.find(row => row.op === 'prompts-application-set')?.args).toMatchObject({ applicationId: 'docs', logicalPrompt: 'code_review', expectedRevision: digest, target: { kind: 'release', reference: 'recipe@2/review' } })
  await expect(page.getByRole('list', { name: 'Prompt mappings', exact: true })).toContainText('recipe@2/review')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: test.info().outputPath(`integrations-mappings-${theme}-mobile.png`) })
  await page.getByRole('button', { name: 'Edit mapping code_review', exact: true }).click()
  const edit = page.getByRole('dialog', { name: 'Edit prompt mapping', exact: true })
  await page.screenshot({ path: test.info().outputPath(`integration-dialog-${theme}-mobile.png`) })
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 320, height: 844 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await edit.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await edit.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit mapping code_review', exact: true })).toBeFocused()
  expect(writes.filter(row => row.op === 'prompts-application-set')).toHaveLength(1)
})

test('prompt mapping conflicts retain the edited target and observed revision', async ({ page }) => {
  const writes = await fixture(page, { conflict: true })
  await openIntegrations(page)
  await page.getByRole('button', { name: 'Manage Pathspec', exact: true }).click()
  await page.getByRole('button', { name: 'Edit mapping review', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit prompt mapping', exact: true })
  await editor.getByLabel('Released prompt', { exact: true }).fill('recipe@2/review')
  await editor.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Resource changed')
  await expect(editor.getByLabel('Released prompt', { exact: true })).toHaveValue('recipe@2/review')
  expect(writes.find(row => row.op === 'prompts-application-set')?.args.expectedRevision).toBe(digest)
})

test('prompt mappings retain exact draft sources and pinned managed revisions', async ({ page }) => {
  const writes = await fixture(page)
  await openIntegrations(page)
  await page.getByRole('button', { name: 'Manage Pathspec', exact: true }).click()
  await page.getByRole('button', { name: 'Edit mapping review', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit prompt mapping', exact: true })
  await editor.getByRole('button', { name: /Use$/, exact: false }).click()
  await page.getByRole('option', { name: 'Registered draft', exact: true }).click()
  await editor.getByRole('button', { name: /Prompt source/ }).click()
  await page.getByRole('option', { name: 'Local drafts', exact: true }).click()
  await editor.getByLabel('Pack directory', { exact: true }).fill('/fixture/prompts/recipe')
  await editor.getByLabel('Prompt name', { exact: true }).fill('review')
  await editor.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(writes.find(row => row.op === 'prompts-application-set')?.args.target).toEqual({ kind: 'draft', source_id: 'exact', pack_path: '/fixture/prompts/recipe', prompt: 'review' })
  await page.getByRole('button', { name: 'Edit mapping review', exact: true }).click()
  await editor.getByRole('button', { name: /Use$/ }).click()
  await page.getByRole('option', { name: 'Managed copy', exact: true }).click()
  await editor.getByLabel('Publisher ID', { exact: true }).fill('local')
  await editor.getByLabel('Managed package ID', { exact: true }).pressSequentially('default')
  await expect(editor.getByLabel('Managed package ID', { exact: true })).toHaveValue('default')
  await editor.getByText('Revision settings', { exact: true }).click()
  await editor.getByLabel('Pinned revision', { exact: true }).fill(digest)
  await editor.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: 'Edit mapping review', exact: true }).click()
  await editor.getByRole('button', { name: 'Save mapping', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(writes.filter(row => row.op === 'prompts-application-set').at(-1)?.args).toMatchObject({ expectedRevision: changed, target: { kind: 'managed', publisher_id: 'local', package_id: 'default', prompt: 'review', revision: digest } })
})

test('ACP permission options are preserved and cancellation never becomes approval', async ({ page }) => {
  const writes = await fixture(page, { waiting: true })
  await page.goto('/#/chat/'+chatId)
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel permission request', exact: true }).click()
  await expect.poll(() => writes.some(row => row.op === 'chat-answer')).toBe(true)
  expect(writes.find(row => row.op === 'chat-answer')?.args).toMatchObject({ chatId, requestId: 'e'.repeat(32), response: { outcome: 'cancelled' } })
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Backend$/ })).toBeDisabled()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Voice conversation', exact: true })).toHaveCount(0)
})
test('backend selection sends the implemented identity and disables unverified access controls', async ({ page }) => {
  const writes = await fixture(page)
  await page.goto('/#/chat')
  const settings = await openChatSettings(page)
  await settings.getByRole('button', { name: / Backend$/ }).click()
  await page.getByRole('option', { name: 'Codex ACP', exact: true }).click()
  await expect(settings.getByLabel('Use profile instructions')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: / Backend access$/ })).toHaveCount(0)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Review this fixture')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => writes.some(row => row.op === 'chat-create')).toBe(true)
  expect(writes.find(row => row.op === 'chat-create')?.args).toMatchObject({ backend: 'codex-acp', profile: 'work', resources: {} })
  expect(writes.find(row => row.op === 'chat-create')?.args).not.toHaveProperty('permissionMode')
  expect(writes.find(row => row.op === 'chat-create')?.args).not.toHaveProperty('useProfileInstructions')
})

test('new chats offer Antigravity without a Gemini provider', async ({ page }) => {
  await fixture(page)
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option', { name: 'Antigravity', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: /Gemini/ })).toHaveCount(0)
})

for (const [provider, label, backend] of [['claude', 'Claude', 'claude-acp'], ['antigravity', 'Antigravity', 'antigravity-sdk']]) {
  test(`${label} selection scopes its profile and starts the matching session`, async ({ page }) => {
    const writes = await fixture(page)
    await page.goto('/#/chat')
    await page.getByRole('button', { name: / Provider$/ }).click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await page.getByRole('button', { name: / Profile$/ }).click()
    await expect(page.getByRole('option', { name: 'Auto', exact: true })).toHaveCount(0)
    await page.getByRole('option', { name: `work (${provider}/work) ${provider} profile`, exact: true }).click()
    await expect(page.getByRole('button', { name: / Model$/ })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill(`Hello ${label}`)
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect.poll(() => writes.some(row => row.op === 'chat-send')).toBe(true)
    const created = writes.find(row => row.op === 'chat-create')!.args
    expect(created).toMatchObject({ provider, profile: 'work', backend })
    expect(created).not.toHaveProperty('permissionMode')
    expect(created).not.toHaveProperty('model')
    expect(writes.some(row => row.op === 'launch')).toBe(false)
  })
}

for (const theme of ['light', 'dark']) test(`unavailable provider explains setup and cannot fall back to another route in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const writes = await fixture(page, { unavailable: 'claude' })
  await page.goto('/#/chat')
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: /^Claude / }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Should stay a draft')
  await expect(page.getByRole('status').filter({ hasText: 'Install the configured agent adapter.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Review provider setup', exact: true }).click()
  await expect(page).toHaveURL(/agents\/providers$/)
  expect(writes.some(row => ['chat-create', 'launch'].includes(row.op))).toBe(false)
})

test('reopening a Claude chat preserves its provider and advertised model controls', async ({ page }) => {
  const writes = await fixture(page, { existingProvider: 'claude' })
  await page.goto('/#/chat/' + chatId)
  await expect(page.getByRole('button', { name: / Provider$/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: / Provider$/ })).toContainText('Claude')
  await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
  await page.getByRole('button', { name: / Model$/ }).click()
  await page.getByRole('option', { name: 'Fixture Two', exact: true }).click()
  await expect.poll(() => writes.some(row => row.op === 'chat-config-set')).toBe(true)
  expect(writes.find(row => row.op === 'chat-config-set')?.args).toMatchObject({ chatId, configId: 'model', value: 'fixture-two' })
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Fixture Two')
  await page.reload()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Fixture Two')
  expect(writes.some(row => row.op === 'chat-create')).toBe(false)
})

test('Claude profile sign-in uses the selected profile instead of a saved-login assignment', async ({ page }) => {
  const writes = await fixture(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Claude', exact: true }).click()
  await expect(page.getByLabel('Saved login', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign in through Claude', exact: true }).click()
  await expect.poll(() => writes.some(row => row.op === 'agent-operation-start')).toBe(true)
  expect(writes.find(row => row.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'claude', profile: 'work', kind: 'profile-login' })
  expect(writes.find(row => row.op === 'agent-operation-start')?.args).not.toHaveProperty('auth')
})
test('profile skill assignments retain the observed revision and immutable store/reference', async ({ page }) => {
  const writes = await fixture(page)
  await page.goto('/#/agents/profiles'); await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Add skills', exact: true }).click()
  await page.getByRole('button', { name: /^Add first\/audit@1/ }).click()
  await page.getByRole('button', { name: 'Save skills and tools', exact: true }).click()
  await expect.poll(() => writes.some(row => row.op === 'profile-resources-set')).toBe(true)
  expect(writes.find(row => row.op === 'profile-resources-set')?.args).toMatchObject({ provider: 'codex', profile: 'work', expectedRevision: digest,
    resources: { instructions: null, skills: [{ target: { kind: 'release', store: '/fixture/store', reference: 'first/audit@1' }, required: false }], mcp: [] } })
})


const agentNav = (page: Page) => page.getByRole('complementary', { name: 'Agent navigation', exact: true })
async function agentSection(page: Page, name: string) {
  const nav = agentNav(page)
  const target = nav.getByRole('button', { name: new RegExp('^' + name) })
  await target.click()
}

test('agent resource sections replace global destinations and keep library and setup destinations visible', async ({ page }) => {
  await fixture(page)
  await page.goto('/#/skills')
  await expect(page).toHaveURL(/#\/agents\/skills$/)
  const rail = page.getByRole('navigation', { name: 'Workspace navigation' })
  await expect(rail.getByRole('link')).toHaveCount(6)
  await expect(rail.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.carrier-sidebar')).toHaveCount(1)
  await expect(agentNav(page).getByRole('group', { name: 'Agent library' }).getByRole('button')).toHaveCount(3)
  await expect(agentNav(page).getByRole('group', { name: 'Agent setup' }).getByRole('button')).toHaveCount(2)
  await agentSection(page, 'Sessions')
  await page.reload()
  await expect(agentNav(page).getByRole('button', { name: /^Profiles/ })).toBeVisible()
  await expect(agentNav(page).getByRole('button', { name: /^Saved logins/ })).toBeVisible()
  await agentSection(page, 'Prompts')
  await expect(agentNav(page).getByRole('button', { name: /^Prompts/ })).toHaveAttribute('aria-pressed', 'true')
})

test('resource selection and search survive section switches, main navigation and reload', async ({ page }) => {
  await fixture(page)
  await page.goto('/#/agents/skills')
  const search = page.getByRole('searchbox', { name: 'Search skills', exact: true })
  await search.pressSequentially('first')
  await expect(search).toBeFocused()
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  const selected = page.url()
  await agentSection(page, 'Sessions')
  await agentSection(page, 'Skills')
  await expect(page).toHaveURL(selected)
  await expect(search).toHaveValue('first')
  const rail = page.getByRole('navigation', { name: 'Workspace navigation' })
  await rail.getByRole('link', { name: 'Home', exact: true }).click()
  await rail.getByRole('link', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(selected)
  await page.reload()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await expect(search).toHaveValue('first')
})

test('saved resource selections and library links retain exact prompt, skill store and MCP identities', async ({ page }) => {
  const calls = await fixture(page, { assigned: true })
  await page.goto('/#/agents/profiles?profile=codex%2Fwork')
  const resources = page.getByRole('region', { name: 'Codex work', exact: true })
  await expect(resources.getByRole('button', { name: /Instructions$/ })).toContainText('review@1/instructions')
  await expect(resources.getByRole('button', { name: /^Actions for first\/audit@1/ })).toBeVisible()
  await expect(resources.getByRole('button', { name: 'Actions for sonar', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('agent-profile-resources.png'), animations: 'disabled' })
  await page.goto('/#/agents/prompts?pack=prompt-release&prompt=instructions&consumer=local-codex&profile=work')
  await expect(page.getByLabel('Prompt content')).toHaveText('Review these changes carefully.')
  await page.getByRole('button', { name: 'Assign to profile', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: /Consumer profile$/ })).toContainText('Local Codex / work')
  await page.keyboard.press('Escape')
  await page.getByRole('region', { name: 'Prompt usage', exact: true }).getByRole('link', { name: 'work · Codex', exact: true }).click()
  await expect(resources).toBeVisible()
  const before = calls.filter(row => row.op === 'profile-resources-get').length
  await page.goto('/#/agents/skills?entry=first%2Faudit%401&store=%2Ffixture%2Fstore')
  await expect(page).toHaveURL(/entry=first%2Faudit%401&store=%2Ffixture%2Fstore/)
  await expect(page.getByRole('button', { name: 'Edit skill', exact: true })).toHaveCount(0)
  const usedBy = page.getByRole('region', { name: 'Skill usage', exact: true })
  await expect(usedBy.getByRole('link')).toHaveCount(1)
  await expect.poll(() => calls.filter(row => row.op === 'profile-resources-get').length - before).toBe(3)
  await usedBy.getByRole('link', { name: 'work · Codex', exact: true }).click()
  await expect(resources).toBeVisible()
  await page.goto('/#/agents/tools?server=sonar')
  await expect(page).toHaveURL(/agents\/tools\?server=sonar$/)
  await expect(page.getByRole('region', { name: 'MCP server details', exact: true })).toContainText('sonar')
  await page.getByRole('link', { name: 'work · Codex', exact: true }).click()
  await expect(resources).toBeVisible()
  await page.goto('/#/agents/prompts?view=assignments')
  await expect(page.getByRole('heading', { name: 'Profile assignments', exact: true })).toBeVisible()
  await page.getByRole('region', { name: 'Prompt profiles' }).getByRole('link', { name: 'review@1/instructions', exact: true }).click()
  await expect(page.getByLabel('Prompt content')).toBeVisible()
  expect(calls.some(row => ['skills-save', 'skills-profile-set', 'profile-resources-set', 'prompts-bind', 'mcp-profile-set', 'mcp-configure', 'session-start'].includes(row.op))).toBe(false)
})

test('a skill link from another store never silently opens the local release', async ({ page }) => {
  const calls = await fixture(page)
  await page.goto('/#/agents/skills?entry=first%2Faudit%401&store=%2Fanother%2Fstore')
  await expect(page.getByRole('heading', { name: 'Skill belongs to another store', exact: true })).toBeVisible()
  expect(calls.some(row => row.op === 'skills-show' || row.op === 'skills-file')).toBe(false)
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await expect(page.getByRole('button', { name: 'Edit skill', exact: true })).toBeEnabled()
})

for (const mode of ['light', 'dark']) test(`skills and grouped agent navigation remain accessible at narrow widths in ${mode}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'audit', exact: true })).toBeFocused()
  await expect(page.locator('.carrier-list-pane')).toBeHidden()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`agent-skills-${mode}-${width}.png`), animations: 'disabled' })
  }
  await page.getByRole('button', { name: 'Back to skills', exact: true }).click()
  await expect(page.getByRole('button', { name: 'audit · first', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Open agent navigation', exact: true }).click()
  const nav = page.getByRole('dialog', { name: 'Agent navigation', exact: true })
  await expect(nav.getByRole('button', { name: /^Saved logins/ })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})


test('skill drafts, release publishing and registered sources retain explicit guarded actions inside Agents', async ({ page }) => {
  const calls = await fixture(page)
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'Skills menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create a draft', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create a draft', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Writable source$/ }).click()
  await page.getByRole('option', { name: 'first', exact: true }).click()
  await page.getByLabel('Skill name', { exact: true }).fill('audit')
  await page.getByRole('button', { name: 'Create skill draft', exact: true }).click()
  await expect.poll(() => calls.some(row => row.op === 'skills-create')).toBe(true)
  const create = calls.find(row => row.op === 'skills-create')!.args
  expect(create).toMatchObject({ sourceId: 'first', name: 'audit' })
  expect(Buffer.from((create.files as Record<string, { content_b64: string }>)['SKILL.md'].content_b64, 'base64').toString()).toContain('name: audit')
  await expect(page.getByLabel('Skill instructions')).toBeVisible()
  await page.getByRole('button', { name: 'Skill actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Validate package', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Package validated' })).toBeVisible()
  await page.getByRole('button', { name: 'Skill actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Publish release', exact: true }).click()
  await page.getByLabel('Release version', { exact: true }).fill('2')
  await page.getByRole('dialog', { name: 'Publish skill release', exact: true }).getByRole('button', { name: 'Publish release', exact: true }).click()
  await expect.poll(() => calls.some(row => row.op === 'skills-release')).toBe(true)
  expect(calls.find(row => row.op === 'skills-release')?.args).toMatchObject({ entryId: digest, version: '2', expectedDigest: digest })
  await expect(page).toHaveURL(/entry=first%2Faudit%402/)
  await expect(page.getByRole('button', { name: 'Open draft', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skills menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Registered skill sources', exact: true }).click()
  await page.getByRole('button', { name: 'Edit source registration', exact: true }).click()
  await page.getByRole('textbox', { name: 'Source paths (one per line)', exact: true }).fill('/fixture/updated-skills')
  await page.getByRole('button', { name: 'Save source registration', exact: true }).click()
  await expect.poll(() => calls.some(row => row.op === 'skills-source-register')).toBe(true)
  expect(calls.find(row => row.op === 'skills-source-register')?.args).toMatchObject({ sourceId: 'first', paths: ['/fixture/updated-skills'], expectedRevision: digest, writable: true })
  expect(calls.some(row => row.op === 'skills-profile-set')).toBe(false)
})


test('profiles with the same name across providers never inherit another provider prompt context', async ({ page }) => {
  const calls = await fixture(page, { assigned: true })
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const resources = page.getByRole('region', { name: 'Claude work', exact: true })
  await expect(resources.getByRole('button', { name: /Instructions$/ })).toContainText('None')
  await expect(resources.getByRole('region', { name: 'Skills', exact: true })).toContainText('None')
  await expect(resources.getByRole('region', { name: 'Tools', exact: true })).toContainText('None')
  expect(calls.filter(row => row.op === 'profile-resources-get').every(row => row.args.provider === 'claude' && row.args.profile === 'work')).toBe(true)
  await page.goto('/#/agents/prompts?view=history&provider=opencode&profile=work&thread=not-a-codex-thread')
  await expect(page.getByRole('heading', { name: 'No conversation history', exact: true })).toBeVisible()
  expect(calls.some(row => row.op === 'prompts-bind')).toBe(false)
})


test('MCP opens a truthful overview and round-trips structured fields through JSON with revision guards', async ({ page }) => {
  const calls = await fixture(page, { assigned: true })
  await page.goto('/#/agents/tools?server=sonar')
  await expect(page.getByRole('heading', { name: 'sonar', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'MCP server definition', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Server executable found.', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add MCP server', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Configure sonar', exact: true })
  await editor.getByRole('textbox', { name: 'Command', exact: true }).fill('node')
  await editor.getByRole('button', { name: 'Add argument', exact: true }).click()
  await editor.getByRole('textbox', { name: 'Argument 1', exact: true }).fill('/path with spaces/server.js')
  await editor.getByText('Environment variables (0)', { exact: true }).click()
  await editor.getByRole('button', { name: 'Add environment variable', exact: true }).click()
  await editor.getByRole('textbox', { name: 'Environment variable 1', exact: true }).fill('DOCS_TOKEN')
  await editor.getByText('Advanced settings', { exact: true }).click()
  await editor.getByRole('textbox', { name: 'Working directory', exact: true }).fill('/workspace/docs')
  await editor.getByRole('spinbutton', { name: 'Tool timeout (seconds)', exact: true }).fill('90')
  await editor.getByRole('button', { name: 'Edit as JSON', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'MCP server definition', exact: true })).toContainText('DOCS_TOKEN')
  await editor.getByRole('button', { name: 'Back to fields', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Argument 1', exact: true })).toHaveValue('/path with spaces/server.js')
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByRole('button', { name: 'Configure', exact: true })).toBeFocused()
  expect(calls.find(row => row.op === 'mcp-configure')?.args).toMatchObject({ name: 'sonar', expectedRevision: digest,
    definition: { kind: 'stdio', command: 'node', args: ['/path with spaces/server.js'], env_vars: ['DOCS_TOKEN'], cwd: '/workspace/docs', tool_timeout_sec: 90 } })
  await expect(page.getByRole('region', { name: 'MCP server details', exact: true })).toContainText('node')
  expect(calls.some(row => ['mcp-profile-set', 'mcp-prepare', 'mcp-chat-reconnect'].includes(row.op))).toBe(false)
})

test('MCP rejects invalid JSON locally and preserves unsaved configuration after conflicts and navigation', async ({ page }) => {
  const calls = await fixture(page, { assigned: true, mcpConflict: true })
  await page.goto('/#/agents/tools?server=sonar')
  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Configure sonar', exact: true })
  await editor.getByText('Advanced settings', { exact: true }).click()
  await editor.getByRole('button', { name: 'Edit as JSON', exact: true }).click()
  const code = editor.getByRole('textbox', { name: 'MCP server definition', exact: true })
  await code.fill('invalid json')
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Invalid JSON')
  expect(calls.some(row => row.op === 'mcp-configure')).toBe(false)
  await code.fill(JSON.stringify({ kind: 'stdio', command: 'custom-server', args: ['--local'], env_vars: ['TOKEN'] }))
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('Resource changed')
  await expect(code).toContainText('custom-server')
  await page.evaluate(() => { window.location.hash = '/home' })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(code).toContainText('custom-server')
  await expect(page).toHaveURL(/agents\/tools\?server=sonar/)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(editor).toBeHidden()
})

for (const theme of ['light', 'dark']) test(`resource editors preserve accessible navigation and preview in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  await fixture(page, { assigned: true })
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await page.screenshot({ path: test.info().outputPath(`skills-overview-${theme}.png`) })
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
  const editor = page.locator('.resource-editor')
  await editor.getByRole('textbox', { name: 'Skill file contents', exact: true }).fill('# Clear instructions\n\nRead these changes before acting.')
  await expect(page.locator('.carrier-list-pane')).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible()
  await editor.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(editor.getByRole('heading', { name: 'Clear instructions', exact: true })).toBeVisible()
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    if (width < 1000) await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path: test.info().outputPath(`skill-editor-${theme}-${width}.png`) })
  }
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Clear instructions', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  await page.goto('/#/agents/tools?server=sonar')
  await page.screenshot({ path: test.info().outputPath(`mcp-overview-${theme}.png`) })
  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  const configuration = page.getByRole('dialog', { name: 'Configure sonar', exact: true })
  await expect(configuration.getByRole('textbox', { name: 'Command', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await configuration.getByText('Advanced settings', { exact: true }).click()
  await configuration.getByRole('button', { name: 'Edit as JSON', exact: true }).click()
  await expect(configuration.getByRole('textbox', { name: 'MCP server definition', exact: true })).toContainText('sonar')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath(`mcp-json-${theme}.png`) })
  await configuration.getByRole('button', { name: 'Back to fields', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: test.info().outputPath(`mcp-configuration-${theme}-mobile.png`) })
  await page.setViewportSize({ width: 320, height: 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await configuration.getByRole('textbox', { name: 'Command', exact: true }).fill('sonar-custom')
  await expect(configuration.getByRole('textbox', { name: 'Command', exact: true })).toBeInViewport()
  await expect(configuration.getByRole('button', { name: 'Save changes', exact: true })).toBeInViewport()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath(`mcp-form-${theme}-320.png`) })
})


test('an explicit legacy MCP definition saves before assignment or runtime work', async ({ page }) => {
  const calls = await fixture(page)
  await page.goto('/#/agents/tools?server=%40new')
  const editor = page.getByRole('dialog', { name: 'Add MCP server', exact: true })
  await editor.getByRole('textbox', { name: 'Server name', exact: true }).fill('docs')
  await editor.getByRole('textbox', { name: 'Command', exact: true }).fill('docs-server')
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(page).toHaveURL(/server=docs/)
  await expect(page.getByRole('heading', { name: 'docs', exact: true })).toBeVisible()
  expect(calls.find(row => row.op === 'mcp-configure')?.args).toMatchObject({ name: 'docs', expectedRevision: null, definition: { command: 'docs-server', kind: 'stdio', args: [], env_vars: [] } })
  expect(calls.some(row => ['mcp-profile-set', 'mcp-prepare', 'mcp-chat-reconnect'].includes(row.op))).toBe(false)
})


test('the shared editor preserves Windows line endings and undo history across preview', async ({ page }) => {
  const calls = await fixture(page, { crlf: true })
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
  const editor = page.locator('.resource-editor')
  const code = editor.getByRole('textbox', { name: 'Skill file contents', exact: true })
  await expect(editor.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await code.press('Control+End'); await code.press('Enter'); await code.pressSequentially('Windows line')
  await editor.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(editor.getByRole('region', { name: 'Resource preview', exact: true })).toContainText('Windows line')
  await editor.getByRole('button', { name: 'Edit', exact: true }).click()
  await code.focus(); await code.press('Control+z')
  await expect(code).not.toContainText('Windows line')
  await code.press('Control+Shift+z')
  await expect(code).toContainText('Windows line')
  await code.press('Control+s')
  await expect(editor).toBeHidden()
  const saved = calls.find(row => row.op === 'skills-save')!.args
  const content = Buffer.from(saved.content_b64 as string, 'base64').toString()
  expect(content).toContain('\r\nWindows line')
  expect(content).not.toMatch(/(?<!\r)\n/)
  expect(saved.expectedDigest).toBe(digest)
})

test('supporting files upload through editor actions and retain their binary payload', async ({ page }) => {
  const calls = await fixture(page)
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
  const editor = page.locator('.resource-editor')
  await editor.getByRole('button', { name: 'File actions', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Upload file', exact: true }).click()
  await (await chooser).setFiles({ name: 'support.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 1, 2]) })
  await expect(editor.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(calls.find(row => row.op === 'skills-save')?.args).toMatchObject({ file: 'support.bin', content_b64: 'AP8BAg==', executable: false, expectedDigest: digest })
})

test('skill content opens directly with file navigation and versions available from the header', async ({ page }) => {
  const calls = await fixture(page)
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByLabel('Skill instructions')).toContainText('Original instructions')
  await expect(page.getByRole('button', { name: /Skill version/ })).toBeVisible()
  await page.getByRole('button', { name: /SKILL.md/ }).click()
  await page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('menuitem', { name: 'refs/bytes.bin', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible()
  await page.getByText('Versions and source', { exact: true }).click()
  await expect(page.locator('.agent-source-details')).toContainText('/fixture/skills/audit')
  expect(calls.some(row => ['skills-save', 'skills-release'].includes(row.op))).toBe(false)
})

test('assigning a released skill preserves other resources and their required flags', async ({ page }) => {
  const calls = await fixture(page, { assigned: true, preserveResources: true })
  await page.goto('/#/agents/skills')
  await page.getByRole('button', { name: 'audit · first', exact: true }).click()
  await page.getByRole('button', { name: 'Skill actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Publish release', exact: true }).click()
  await page.getByLabel('Release version', { exact: true }).fill('2')
  await page.getByRole('dialog', { name: 'Publish skill release', exact: true }).getByRole('button', { name: 'Publish release', exact: true }).click()
  const assign = page.getByRole('button', { name: 'Assign to profile', exact: true })
  await assign.click()
  const dialog = page.getByRole('dialog', { name: 'Assign skill to profile', exact: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(assign).toBeFocused()
  expect(calls.filter(row => row.op === 'profile-resources-set')).toHaveLength(0)
  await assign.click()
  await dialog.getByRole('button', { name: /Profile$/ }).click()
  await page.getByRole('option', { name: 'work · Codex', exact: true }).click()
  await dialog.getByRole('button', { name: 'Assign skill', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(calls.find(row => row.op === 'profile-resources-set')?.args).toEqual({ provider: 'codex', profile: 'work', expectedRevision: digest, resources: {
    instructions: { target: 'review@1/instructions', required: false, inputs: {} },
    mcp: [{ target: 'sonar', required: false }],
    skills: [{ target: { kind: 'release', store: '/other/store', reference: 'other/research@3' }, required: false },
      { target: { kind: 'release', store: '/fixture/store', reference: 'first/audit@2' }, required: true }],
  } })
  await expect(page.getByRole('region', { name: 'Skill usage', exact: true }).getByRole('link', { name: 'work · Codex', exact: true })).toBeVisible()
  expect(calls.filter(row => row.op === 'profile-resources-set')).toHaveLength(1)
})

test('skill assignment conflicts retain the chosen profile without changing other defaults', async ({ page }) => {
  const calls = await fixture(page, { conflict: true })
  await page.goto('/#/agents/skills?entry=first%2Faudit%401')
  await page.getByRole('button', { name: 'Assign to profile', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Assign skill to profile', exact: true })
  await dialog.getByRole('button', { name: /Profile$/ }).click()
  await page.getByRole('option', { name: 'work · Claude', exact: true }).click()
  await dialog.getByRole('button', { name: 'Assign skill', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Resource changed')
  await expect(dialog.getByRole('button', { name: /Profile$/ })).toContainText('work · Claude')
  expect(calls.find(row => row.op === 'profile-resources-set')?.args).toMatchObject({ provider: 'claude', profile: 'work', expectedRevision: digest })
})

test('MCP configuration retains installation recipes when saving structured fields', async ({ page }) => {
  const calls = await fixture(page, { assigned: true })
  await page.goto('/#/agents/tools?server=sonar')
  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Configure sonar', exact: true })
  await dialog.getByText('Advanced settings', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Edit as JSON', exact: true }).click()
  const installation = { kind: 'fixture-runtime', package: 'example-server' }
  await dialog.getByRole('textbox', { name: 'MCP server definition', exact: true }).fill(JSON.stringify({ kind: 'stdio', command: 'node', args: ['server.js'], installation }))
  await dialog.getByRole('button', { name: 'Back to fields', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Command', exact: true }).fill('node-custom')
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(calls.find(row => row.op === 'mcp-configure')?.args.definition).toEqual({ kind: 'stdio', command: 'node-custom', args: ['server.js'], installation })
})
