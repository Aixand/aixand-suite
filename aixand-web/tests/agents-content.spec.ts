import { test, expect, mockAuthentication, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Defaults } from '../src/agents/ResourcePicker'
import type { Profile } from '../src/agents/client'

async function contentFixture(page: Page, options: { conflict?: boolean; unknownAccount?: boolean; unavailableResources?: boolean } = {}) {
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
      else if (op === 'resource-catalog') result = { choices: { instructions: [
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
      else if (op === 'models') result = [{ id: 'model-one', name: 'Model One' }, { id: 'model-two', name: 'Model Two' }]
      else if (op === 'providers') result = { providers: catalog.capabilities.map(row => ({ provider: row.provider, installed: true, version: '1.0', path: '/bin/provider', method: 'npm',
        methods: [{ id: 'npm', label: 'npm', error: null }], canUpdate: false, error: null, activeProfiles: [] })) }
      else if (op === 'prompts-catalog') result = { packs: [{ id: 'review', name: 'review', reference: 'review@1', kind: 'release', prompts: [{ name: 'instructions', inputs: { language: { type: 'string' } } }] }], sources: [], sourceRegistrations: [], consumers: [], applications: [] }
      else if (op === 'skills-catalog') result = { entries: [], releases: [], sources: [], store: '/skills', store_id: 'skills' }
      else if (op.endsWith('-managed-list')) result = { items: [], store_id: 'store', store: '/resources', capabilities: { source_jobs: true } }
      else if (op === 'mcp-catalog') result = { servers: [] }
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return { calls, errors, profiles, emit: (event: object) => emit(event), resources: () => resources }
}
async function openProfile(page: Page, name = 'work · Codex') {
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('button', { name: /Skills & tools.*1 skill/ })).toBeVisible()
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
  await page.goto('/#/agents/tools')
  await expect(page.locator('.carrier-list-heading').getByRole('button', { name: 'Add MCP server', exact: true })).toBeVisible()
  await expect(page.locator('.carrier-sidebar').getByRole('button', { name: 'Add MCP server', exact: true })).toHaveCount(0)
  expect(state.errors).toEqual([])
})
for (const theme of ['light', 'dark'] as const) test('focused profile tasks and shared controls in ' + theme, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const state = await contentFixture(page)
  await openProfile(page)
  await expect(page.locator('.agent-profile-overview input, .agent-profile-overview select, .agent-profile-overview textarea')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Delete Codex profile/ })).toHaveCount(0)
  await expect(page.getByText('No saved sessions in this profile yet.', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'artifacts/agents-content/profile-' + theme + '.png' })
  await page.getByRole('button', { name: /^Account company/ }).click()
  const editor = page.getByRole('region', { name: 'Account', exact: true })
  await editor.getByRole('button', { name: /Saved account$/ }).click()
  await page.getByRole('option', { name: /^personal/ }).click()
  await editor.getByRole('button', { name: 'Use personal account', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Account personal/ })).toBeVisible()
  expect(state.calls.filter(row => row.op === 'switch-auth')).toHaveLength(1)
  await page.getByRole('button', { name: /^Model & instructions/ }).click()
  await expect(page.getByText(/The model is managed in Codex/)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'language', exact: true })).toHaveValue('English')
  await page.getByRole('textbox', { name: 'language', exact: true }).fill('Filipino')
  await page.screenshot({ path: 'artifacts/agents-content/instructions-' + theme + '.png' })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Model & instructions/ })).toBeVisible()
  expect(state.resources().instructions?.inputs).toEqual({ language: 'Filipino' })
  expect(state.resources().skills).toEqual([{ target: { kind: 'release', store: '/skills', reference: 'testing@1' }, required: true }])
  expect(state.resources().mcp).toEqual([{ target: 'search', required: false }])
  expect(state.errors).toEqual([])
})
test('attached resources preserve other defaults, required flags and conflicts', async ({ page }) => {
  const state = await contentFixture(page, { conflict: true })
  await openProfile(page)
  await page.getByRole('button', { name: /^Skills & tools/ }).click()
  await expect(page.getByRole('button', { name: 'Documentation Add' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Add skills', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search skills' }).fill('Documentation')
  await page.getByRole('button', { name: /Documentation.*Add$/ }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Profile resources changed' })).toBeVisible()
  const write = state.calls.find(row => row.op === 'profile-resources-set')!
  expect(write.args.resources.instructions).toEqual(state.resources().instructions)
  expect(write.args.resources.skills).toHaveLength(2)
  expect(write.args.resources.skills[0].required).toBe(true)
  expect(write.args.resources.mcp).toEqual(state.resources().mcp)
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'Discard your changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Skills & tools', exact: true })).toBeVisible()
  expect(state.errors).toEqual([])
})
test('unknown account access requires a check and resource failures remain visible', async ({ page }) => {
  const state = await contentFixture(page, { unknownAccount: true, unavailableResources: true })
  await page.goto('/#/agents/profiles?profile=codex%2Fwork')
  await expect(page.getByRole('alert').filter({ hasText: 'Resource store unavailable' })).toBeVisible()
  await page.getByRole('button', { name: /^Account company/ }).click()
  await page.getByRole('button', { name: /Saved account$/ }).click()
  await page.getByRole('option', { name: /^personal/ }).click()
  await expect(page.getByRole('button', { name: 'Check account', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use personal account', exact: true })).toBeDisabled()
  expect(state.calls.some(row => row.op === 'switch-auth')).toBe(false)
})
test('profile summary and resource editor remain readable at narrow widths', async ({ page }) => {
  await contentFixture(page)
  await openProfile(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'New profile', exact: true })).not.toBeVisible()
  await page.screenshot({ path: 'artifacts/agents-content/profile-mobile.png' })
  await page.getByRole('button', { name: /^Skills & tools/ }).click()
  await page.getByRole('button', { name: 'Add tools', exact: true }).click()
  await page.screenshot({ path: 'artifacts/agents-content/resources-mobile.png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('model selection saves independently and resource editing keeps the instruction assignment', async ({ page }) => {
  const state = await contentFixture(page)
  await openProfile(page, 'research · OpenCode')
  await page.getByRole('button', { name: /^Model & instructions/ }).click()
  await page.getByRole('button', { name: /Default model$/ }).click()
  await page.getByRole('option', { name: 'Model Two', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Model & instructions model-two/ })).toBeVisible()
  expect(state.calls.filter(row => row.op === 'set-model')).toHaveLength(1)
  expect(state.calls.filter(row => row.op === 'profile-resources-set')).toHaveLength(0)
  await page.getByRole('button', { name: /^Skills & tools/ }).click()
  await page.getByRole('button', { name: 'Add tools', exact: true }).click()
  await page.getByRole('button', { name: 'GitHub Add', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for GitHub', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Require for new sessions', exact: true }).click()
  await expect(page.getByRole('menu', { name: 'Actions for GitHub' })).toBeHidden()
  await page.getByRole('button', { name: 'Actions for Testing', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from profile', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Skills & tools 0 skills · 2 tools/ })).toBeVisible()
  expect(state.resources().instructions?.inputs).toEqual({ language: 'English' })
  expect(state.resources().mcp).toEqual([{ target: 'search', required: false }, { target: 'github', required: true }])
  expect(state.resources().skills).toEqual([])
  expect(state.errors).toEqual([])
})

test('conflict recovery and profile navigation respect the unsaved draft', async ({ page }) => {
  const state = await contentFixture(page, { conflict: true })
  await openProfile(page)
  await page.getByRole('button', { name: /^Skills & tools/ }).click()
  await page.getByRole('button', { name: 'Actions for Testing', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from profile', exact: true }).click()
  await page.getByRole('button', { name: 'research · OpenCode', exact: true }).click()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page.getByRole('button', { name: 'work · Codex', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('No skills attached.', { exact: true })).toBeVisible()
  const reads = state.calls.filter(row => row.op === 'resource-catalog').length
  state.emit({ type: 'skills-changed' })
  await expect.poll(() => state.calls.filter(row => row.op === 'resource-catalog').length).toBeGreaterThan(reads)
  await expect(page.getByText('No skills attached.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByRole('button', { name: 'Reload saved setup', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Actions for Testing', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
})
