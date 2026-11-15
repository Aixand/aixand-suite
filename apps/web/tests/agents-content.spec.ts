import { test, expect, mockAuthentication, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Defaults } from '../src/agents/ResourcePicker'
import type { Profile } from '../src/agents/client'

async function contentFixture(page: Page, options: { conflict?: boolean; unknownAccount?: boolean; unavailableResources?: boolean; invalidModels?: boolean } = {}) {
  await mockAuthentication(page)
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const calls: { op: string; args: Record<string, any> }[] = []
  let emit = (_event: object) => {}
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const profiles: Profile[] = [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'company', active_runs: 0, readiness: { ready: true, verification: 'verified' } },
    { id: 'opencode/research', provider: 'opencode', profile: 'research', auth: 'personal', model: 'model-one', active_runs: 0 },
  ]
  const skills = [{ label: 'Testing', description: 'Guidance for writing tests', target: { kind: 'release' as const, store: '/skills', reference: 'testing@1' } },
    { label: 'Documentation', description: 'Keep project documentation up to date', target: { kind: 'release' as const, store: '/skills', reference: 'documentation@1' } }]
  let resources: Defaults = { revision: 'r1', instructions: { target: 'review@1/instructions', required: true, inputs: { language: 'English' } },
    skills: [{ target: skills[0].target, required: true }], mcp: [{ target: 'search', required: false }] }
  const catalog = { profiles, cwd: '/workspace', auths: [
    { provider: 'codex', auth: 'company', profiles: ['work'], verification: 'verified' },
    { provider: 'codex', auth: 'personal', profiles: [], verification: options.unknownAccount ? null : 'verified' },
    { provider: 'opencode', auth: 'personal', profiles: ['research'], verification: 'verified' },
  ], capabilities: [{ provider: 'codex', installed: true, savedModels: false, budgets: false }, { provider: 'opencode', installed: true, savedModels: true, budgets: false }] }
  await page.routeWebSocket('**/api/agents/ws', socket => {
    emit = event => socket.send(JSON.stringify(event))
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw)); const { id, op } = command; const args = command.args ?? {}
      if (!op) return
      calls.push({ op, args })
      let result: unknown = []
      if (op === 'catalog') result = catalog
      else if (op === 'sessions') result = { runs: [], runtimeError: null }
      else if (op === 'session-list') result = { sessions: [], total: 0, homes: profiles, projects: [], counts: {}, errors: [] }
      else if (op === 'agent-operations') result = { operations: [] }
      else if (op === 'project-discovery-list') result = { jobs: [] }
      else if (op === 'command-list') result = { monitors: [] }
      else if (op === 'profile-resources-get') {
        if (options.unavailableResources) { socket.send(JSON.stringify({ type: 'error', id, code: 'unavailable', message: 'Resource store unavailable.' })); return }
        result = resources
      }
      else if (op === 'resource-catalog') result = { profileDefaultsSupported: false, choices: { instructions: [
        { label: 'Code review', description: 'Review changes for correctness', target: 'review@1/instructions' },
        { label: 'Documentation', target: 'docs@1/instructions' },
      ], skills, mcp: [{ label: 'Search', description: 'Search project sources', target: 'search' }, { label: 'GitHub', target: 'github', installation: { installation_required: true } }] } }
      else if (op === 'profile-resources-set') {
        if (options.conflict) { socket.send(JSON.stringify({ type: 'error', id, code: 'conflict', message: 'Profile resources changed. Reload before saving.' })); return }
        expect(args.expectedRevision).toBe(resources.revision)
        resources = { ...args.resources, revision: 'r2' }; result = resources
      }
      else if (op === 'switch-auth') { profiles.find(row => row.profile === args.profile)!.auth = args.auth; result = { saved: true } }
      else if (op === 'set-model') { profiles.find(row => row.profile === args.profile)!.model = args.model; result = { saved: true } }
      else if (op === 'models') result = options.invalidModels ? {} : [{ id: 'model-one', name: 'Model One' }, { id: 'model-two', name: 'Model Two' }]
      else if (op === 'providers') result = { providers: catalog.capabilities.map(row => ({ provider: row.provider, installed: true, version: '1.0', path: '/bin/provider', method: 'npm',
        methods: [{ id: 'npm', label: 'npm', error: null }], canUpdate: false, error: null, activeProfiles: [] })) }
      else if (op === 'prompts-catalog') result = { packs: [{ id: 'review', name: 'review', reference: 'review@1', kind: 'release', prompts: [{ name: 'instructions', inputs: { language: { type: 'string' } } }] }], sources: [], sourceRegistrations: [], consumers: [], applications: [], profileBindingsSupported: false }
      else if (op === 'skills-catalog') result = { entries: [], releases: [], sources: [], store: '/skills', store_id: 'skills' }
      else if (op.endsWith('-managed-list')) result = { items: [], store_id: 'store', store: '/resources', capabilities: { source_jobs: op !== 'prompts-managed-list', github: false } }
      else if (op === 'mcp-catalog') result = { servers: [] }
      else if (op === 'prompts-managed-create') { socket.send(JSON.stringify({ type: 'error', id, code: 'conflict', message: 'A prompt with this name already exists.' })); return }
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return { calls, errors, profiles, emit: (event: object) => emit(event), resources: () => resources }
}
async function openProfile(page: Page, name = 'work · Codex') {
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('region', { name: 'Resource libraries', exact: true })).toBeVisible()
}
test('creation belongs to the active collection and both entry points use provider setup', async ({ page }) => {
  const state = await contentFixture(page)
  await openProfile(page)
  await expect(page.locator('.carrier-sidebar .agent-create')).toHaveCount(0)
  await expect(page.locator('.carrier-list-heading').getByRole('button', { name: 'New profile', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'New agent profile' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page).toHaveURL(/agents\/providers\?provider=codex&setup=profile/)
  await expect(page.locator('.carrier-list-heading .agent-create')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Codex setup' })).toBeVisible()
  await expect(page.locator('.agent-workspace')).not.toHaveClass(/agent-refined/)
  await page.goto('/#/agents/tools')
  await expect(page.locator('.carrier-list-heading').getByRole('button', { name: 'Add MCP server', exact: true })).toBeVisible()
  await expect(page.locator('.carrier-sidebar').getByRole('button', { name: 'Add MCP server', exact: true })).toHaveCount(0)
  expect(state.errors).toEqual([])
})
for (const theme of ['light', 'dark'] as const) test('profile administration and libraries in ' + theme, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const state = await contentFixture(page, { unavailableResources: true })
  await openProfile(page)
  await expect(page.getByText('No sessions yet.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Instruction settings' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add tools', exact: true })).toHaveCount(0)
  const account = page.getByRole('region', { name: 'Account', exact: true })
  await account.getByRole('button', { name: /Saved account$/ }).click()
  await page.getByRole('option', { name: /^personal/ }).click()
  await account.getByRole('button', { name: 'Save account', exact: true }).click()
  await expect(account.getByRole('button', { name: /Saved account$/ })).toContainText('personal')
  expect(state.calls.some(row => row.op.startsWith('profile-resources-'))).toBe(false)
  expect(state.errors).toEqual([])
})

test('model defaults save without resource bindings or a working resource manager', async ({ page }) => {
  const state = await contentFixture(page, { unavailableResources: true })
  await openProfile(page, 'research · OpenCode')
  await page.getByRole('button', { name: /Default model$/ }).click()
  await page.getByRole('option', { name: 'Model Two', exact: true }).click()
  await page.getByRole('button', { name: 'Save default model', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save default model' })).toHaveCount(0)
  expect(state.calls.find(row => row.op === 'set-model')?.args.model).toBe('model-two')
  expect(state.calls.some(row => row.op.startsWith('profile-resources-'))).toBe(false)
})

test('an unavailable model list permits an explicit custom model', async ({ page }) => {
  const state = await contentFixture(page, { invalidModels: true })
  await openProfile(page, 'research · OpenCode')
  await expect(page.getByText('Couldn’t load models. Enter a model ID to continue.')).toBeVisible()
  await page.getByRole('button', { name: /Default model$/ }).click()
  await page.getByRole('option', { name: 'Enter a model ID…', exact: true }).click()
  await page.getByRole('textbox', { name: 'Model ID', exact: true }).fill(' custom-model ')
  await page.getByRole('button', { name: 'Save default model' }).click()
  await expect(page.getByRole('button', { name: 'Save default model' })).toHaveCount(0)
  expect(state.calls.find(row => row.op === 'set-model')?.args.model).toBe('custom-model')
})

test('library navigation respects an unsaved model draft', async ({ page }) => {
  await contentFixture(page)
  await openProfile(page, 'research · OpenCode')
  await page.getByRole('button', { name: /Default model$/ }).click()
  await page.getByRole('option', { name: 'Model Two', exact: true }).click()
  await page.getByRole('region', { name: 'Resource libraries' }).getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'Discard your changes?' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save default model' })).toBeVisible()
})

test('profile settings stay readable at narrow widths', async ({ page }) => {
  const state = await contentFixture(page)
  await openProfile(page)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 320, height: 844 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await page.locator('.carrier-reader-scroll').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(state.errors).toEqual([])
})

test('prompts hide removed profile bindings and offer local creation', async ({ page }) => {
  const state = await contentFixture(page)
  await page.goto('/#/agents/prompts')
  await expect(page.getByRole('button', { name: 'Add prompt', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Profile assignments', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Add prompt', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Prompt name', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import from GitHub', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import local package', exact: true })).toBeVisible()
  expect(state.calls.some(row => row.op === 'prompts-bind')).toBe(false)
})

test('old prompt assignment links explain launch selections without invoking removed APIs', async ({ page }) => {
  const state = await contentFixture(page)
  await page.goto('/#/agents/prompts?view=assignments')
  await expect(page.getByText('Profiles no longer own prompt assignments.', { exact: false })).toBeVisible()
  expect(state.calls.some(row => ['prompts-bind', 'prompts-history', 'prompts-unbind'].includes(row.op))).toBe(false)
})

test('MCP library describes chat selection instead of profile assignments', async ({ page }) => {
  const state = await contentFixture(page)
  await page.goto('/#/agents/tools')
  await expect(page.getByText('Add a server to configure tools for new chats.')).toBeVisible()
  expect(state.calls.find(row => row.op === 'mcp-catalog')?.args).toEqual({})
})

test('prompt creation calls the direct API and retains content on a conflict', async ({ page }) => {
  const state = await contentFixture(page)
  await page.goto('/#/agents/prompts?import=add')
  await page.getByRole('textbox', { name: 'Prompt name', exact: true }).fill('review')
  await page.getByRole('textbox', { name: 'Prompt text', exact: true }).fill('Review the changes.')
  await page.getByRole('button', { name: 'Create prompt', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('A prompt with this name already exists.')
  await expect(page.getByRole('textbox', { name: 'Prompt text', exact: true })).toHaveValue('Review the changes.')
  expect(state.calls.find(row => row.op === 'prompts-managed-create')?.args).toMatchObject({ name: 'review', content: 'Review the changes.', role: 'system' })
  expect(state.calls.some(row => row.op === 'prompts-managed-source-job-start')).toBe(false)
})
