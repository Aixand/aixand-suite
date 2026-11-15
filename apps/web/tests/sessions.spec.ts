import { test, expect, mockAuthentication } from './fixtures'
import type { Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { AGENT_NAVIGATION_KEY } from '../src/agents/routes'
import type { Catalog, SavedSession } from '../src/agents/client'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

async function historyFixture(page: Page, uncertain = false, extraSessions = 0, instructions: { older?: boolean; error?: boolean } = {}) {
  await mockAuthentication(page)
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const catalog: Catalog = { cwd: '/projects/web', profiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'company', active_runs: 0 },
    { id: 'codex/research', provider: 'codex', profile: 'research', auth: 'personal', active_runs: 0 },
    { id: 'opencode/default', provider: 'opencode', profile: 'default', auth: null, active_runs: 0 },
  ], auths: [{ provider: 'codex', auth: 'company', profiles: ['work'] }, { provider: 'codex', auth: 'personal', profiles: ['research'] }],
    capabilities: [{ provider: 'codex', installed: true, budgets: true, savedModels: false }, { provider: 'opencode', installed: true, budgets: false, savedModels: true }] }
  const sessions: SavedSession[] = [
    { id: '11111111-1111-4111-8111-111111111111', key: 'codex/work/11111111-1111-4111-8111-111111111111', provider: 'codex', profile: 'work', auth: 'company',
      title: 'Fix login redirect', cwd: '/projects/web', home: '/homes/work', updatedAt: Date.now(), archived: false, state: 'saved', terminalId: null, runIds: [], canContinue: true },
    { id: '22222222-2222-4222-8222-222222222222', key: 'codex/research/22222222-2222-4222-8222-222222222222', provider: 'codex', profile: 'research', auth: 'personal',
      title: 'Review API changes', cwd: '/projects/server', home: '/homes/research', updatedAt: Date.now() - 5000, archived: false, state: 'running', terminalId: 'running-terminal', runIds: ['running-run'], canContinue: true },
    { id: 'ses_native', key: 'opencode/default/ses_native', provider: 'opencode', profile: 'default', auth: null, title: 'Native home conversation', cwd: '/projects/other',
      home: '/homes/native', updatedAt: Date.now() - 10000, archived: false, state: 'saved', terminalId: null, runIds: [], canContinue: false },
  ]
  for (let n = 0; n < extraSessions; n++) sessions.push({ ...sessions[0], id: `extra-${n}`, key: `codex/work/extra-${n}`, title: `Earlier task ${n}`, updatedAt: Date.now() - (n + 1) * 60000 })
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      calls.push(command)
      const args = command.args ?? {}
      let result: unknown = {}
      if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      if (command.op === 'profile-resources-get') result = { revision: 'fixture', instructions: null, skills: [], mcp: [] }
      if (command.op === 'launch-preview') result = { report: { items: [] } }
      if (command.op === 'catalog') result = catalog
      if (command.op === 'project-list') result = [{ id: '33333333-3333-4333-8333-333333333333', name: 'Web', path: '/projects/web' }]
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      if (command.op === 'agent-operations') result = { operations: [] }
      if (command.op === 'chat-list') result = []
      if (command.op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      if (command.op === 'mcp-catalog') result = { servers: [] }
      if (command.op === 'mcp-preview') result = { states: [], selection: {} }
      if (command.op === 'prompts-catalog') result = { checked_at: 'fixture', packs: [], sources: [], consumers: [
        { id: 'other-provider', local: true, provider: 'opencode', label: 'Other provider', status: 'available', profiles: [], launches: [{ id: 'wrong-provider', profile: 'work', thread_id: sessions[0].id, status: 'bound' }] },
        { id: 'local-codex', local: true, provider: 'codex', label: 'Local Codex', status: 'available', profiles: [], launches: [
          { id: 'wrong-session', profile: 'work', thread_id: 'another-session', status: 'bound' },
          { id: 'wrong-profile', profile: 'research', thread_id: sessions[0].id, status: 'bound' },
          ...(instructions.older ? [] : [{ id: 'saved-run', profile: 'work', thread_id: sessions[0].id, status: 'bound', reference: 'review@1/instructions' }]),
        ], next_offset: instructions.older ? 50 : null },
      ] }
      if (command.op === 'prompts-history') result = { launches: [{ id: 'saved-run', profile: 'work', thread_id: sessions[0].id, status: 'bound', reference: 'review@1/instructions' }], next_offset: null }
      if (command.op === 'prompts-snapshot') {
        if (instructions.error) { socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'unavailable', message: 'Saved instructions are temporarily unavailable.' })); return }
        result = { status: 'bound', thread_id: sessions[0].id, instructions: { reference: 'review@1/instructions', developer_instructions: 'Review the original changes carefully.', provenance: { release: { digest: 'saved-prompt-digest' } } } }
      }
      if (command.op === 'session-list') {
        const rows = sessions.filter((row) => (!args.home || `${row.provider}/${row.profile}` === args.home) &&
          (!args.cwd || row.cwd === args.cwd) && (!args.query || row.title.toLowerCase().includes(String(args.query).toLowerCase())) &&
          (args.view !== 'running' || row.state === 'running') && args.view !== 'archived')
        const offset = Number(args.offset ?? 0)
        result = { sessions: rows.slice(offset, offset + 25), total: rows.length, nextOffset: offset + 25 < rows.length ? offset + 25 : null, homes: catalog.profiles.map((profile) => ({ id: profile.id, profile: profile.profile, provider: profile.provider })),
          projects: ['/projects/web', '/projects/server', '/projects/other'], counts: { all: 3, running: 1, attention: 0, archived: 0 }, errors: [] }
      }
      if (command.op === 'session-transcript') result = { session: sessions.find((row) => row.id === args.id), total: 4, partial: false,
        nextBefore: args.before == null ? 1 : null, items: args.before == null ? [
          { id: 'user', type: 'userMessage', text: 'Fix the redirect after signing in.' },
          { id: 'tool', type: 'commandExecution', command: 'rg redirect', text: 'Found the redirect', status: 'completed', raw: '{"type":"response_item"}' },
          { id: 'reply', type: 'agentMessage', text: 'The redirect now uses the original destination.' },
        ] : [{ id: 'earlier', type: 'userMessage', text: 'Earlier conversation context.' }] }
      if (command.op === 'session-start') {
        if (uncertain) { socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'launch_uncertain', runId: 'retained', message: 'Launch result is unconfirmed. Check Terminals.' })); return }
        result = { run_id: 'new-run', session_id: 'new-terminal' }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  return { calls, sessions, catalog }
}

test('sessions aggregate homes and selecting history renders a passive, paged transcript', async ({ page }) => {
  const fixture = await historyFixture(page)
  await page.goto('/#/agents/sessions')
  await expect(page.locator('.carrier-message-row')).toHaveCount(3)
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await expect(page.getByRole('heading', { name: 'Fix login redirect', exact: true })).toBeVisible()
  await expect(page.getByText('The redirect now uses the original destination.', { exact: true })).toBeVisible()
  expect(fixture.calls.filter((call) => ['launch', 'session-start', 'chat-open'].includes(call.op))).toHaveLength(0)
  await page.getByRole('button', { name: 'Load earlier messages' }).click()
  await expect(page.getByText('Earlier conversation context.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More session actions' }).click()
  await page.getByRole('menuitem', { name: 'View raw records' }).click()
  await expect(page.locator('.session-records')).toHaveCount(4)
  await page.screenshot({ path: 'artifacts/agents-workspace/sessions.png' })
})

test('session filtering preserves search focus and running sessions open their existing terminal', async ({ page }) => {
  await historyFixture(page)
  await page.goto('/#/agents/sessions')
  await page.getByRole('searchbox', { name: 'Search sessions', exact: true }).focus()
  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill('redirect')
  await expect(search).toBeFocused()
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill('')
  await page.getByRole('button', { name: /Session status$/ }).click()
  await page.getByRole('option', { name: 'Running', exact: true }).click()
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await page.getByRole('button', { name: /Review API changes/ }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/terminals\/running-terminal/)
})

test('resume uses the native profile without saved-login or resource overrides', async ({ page }) => {
  const fixture = await historyFixture(page)
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Continue session' })).toContainText("native login, tools, and instructions")
  await expect(page.getByRole('button', { name: /Saved login$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect.poll(() => fixture.calls.find(call => call.op === 'session-start')?.args).toMatchObject({ profile: 'work', sourceProfile: 'work', expectedAuth: null, id: fixture.sessions[0].id })
  const args = fixture.calls.find(call => call.op === 'session-start')!.args
  expect(args).not.toHaveProperty('auth')
  expect(args).not.toHaveProperty('resources')
  expect(args).not.toHaveProperty('suiteTools')
})

test('session references keep native IDs separate and capture the launch environment', async ({ page }) => {
  const fixture = await historyFixture(page)
  const ref = 'a'.repeat(64)
  const environmentId = '44444444-4444-4444-8444-444444444444'
  const profileId = '55555555-5555-4555-8555-555555555555'
  fixture.sessions[0] = { ...fixture.sessions[0], nativeId: fixture.sessions[0].id, id: ref,
    key: `codex/work/${ref}`, environmentId, profiles: ['work'], canResume: true }
  Object.assign(fixture.catalog.profiles[0], { environment_id: environmentId, profile_id: profileId,
    revision: 'alias-revision', environment_revision: 'environment-revision' })
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await expect(page).toHaveURL(new RegExp(ref))
  await expect.poll(() => fixture.calls.find(call => call.op === 'session-transcript')?.args.id).toBe(ref)
  await page.getByRole('button', { name: 'Session details', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Session details', exact: true })).toContainText(fixture.sessions[0].nativeId!)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect.poll(() => fixture.calls.find(call => call.op === 'session-start')?.args).toMatchObject({
    id: ref, environmentId, profileId, expectedRevision: 'alias-revision', expectedEnvironmentRevision: 'environment-revision', expectedAuth: null,
  })
})

test('another profile uses native continuation with its own settings', async ({ page }) => {
  const fixture = await historyFixture(page)
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await page.getByRole('button', { name: 'More session actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Continue with…', exact: true }).click()
  await page.getByRole('button', { name: /Agent profile$/ }).click()
  await page.getByRole('option', { name: 'research · Codex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Continue session' })).toContainText("Agent Manager will continue this session in research")
  await page.getByRole('button', { name: 'Continue in selected profile' }).click()
  await expect.poll(() => fixture.calls.find((call) => call.op === 'session-start')?.args).toMatchObject({ profile: 'research', sourceProfile: 'work', expectedAuth: null })
})

test('an uncertain launch prevents accidental replay', async ({ page }) => {
  const fixture = await historyFixture(page, true)
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Continue session' }).getByRole('alert')).toContainText('unconfirmed')
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeDisabled()
  expect(fixture.calls.filter((call) => call.op === 'session-start')).toHaveLength(1)
})

test('Agents uses the same transcript reader and links to sessions scoped to its profile', async ({ page }) => {
  await historyFixture(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  await expect(page.getByText('The redirect now uses the original destination.', { exact: true })).toBeVisible()
  await openProfiles(page)
  await page.getByRole('button', { name: 'View sessions', exact: true }).click()
  await expect(page).toHaveURL(/sessions\?home=codex%2Fwork/)
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
})

for (const theme of ['light', 'dark']) test(`mobile sessions preserve list context and remain accessible in ${theme}`, async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('aixand.appearance', theme), theme)
  await historyFixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agents/sessions')
  const row = page.getByRole('button', { name: /Fix login redirect/ })
  await row.click()
  await expect(page.locator('.carrier-list-pane')).toBeHidden()
  await expect(page.locator('.carrier-reader')).toBeVisible()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Back to all sessions' }).click()
  await expect(row).toBeFocused()
  await row.click()
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `artifacts/agents-workspace/sessions-${theme}-mobile.png` })
})

const agentNavigation = (page: Page) => page.getByRole('complementary', { name: 'Agent navigation', exact: true })
async function openProfiles(page: Page) {
  const navigation = agentNavigation(page)
  await navigation.getByRole('button', { name: /^Profiles/ }).click()
}
async function sessionFilter(page: Page, label: string, value: string) {
  const trigger = page.getByRole('button', { name: /^Filter sessions/ })
  if (!(await page.getByRole('dialog', { name: 'Filter sessions', exact: true }).isVisible())) await trigger.click()
  await page.getByRole('dialog', { name: 'Filter sessions', exact: true }).getByRole('button', { name: new RegExp(label + '$') }).click()
  await page.getByRole('option', { name: value, exact: true }).click()
}

test('Agents opens all sessions first, with one section sidebar and quieter setup navigation', async ({ page }) => {
  const fixture = await historyFixture(page)
  await page.goto('/#/agents')
  await expect(page).toHaveURL(/#\/agents\/sessions$/)
  await expect(page.getByRole('heading', { name: 'All sessions', exact: true })).toBeVisible()
  await expect(page.locator('.carrier-message-row')).toHaveCount(3)
  const rail = page.getByRole('navigation', { name: 'Workspace navigation' })
  await expect(rail.getByRole('link', { name: 'Sessions', exact: true })).toHaveCount(0)
  await expect(rail.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.agent-workspace')).toHaveCount(1)
  await expect(page.locator('.carrier-sidebar')).toHaveCount(1)
  await expect(agentNavigation(page).getByRole('group', { name: 'Agent sections' }).getByRole('button')).toHaveCount(2)
  await expect(agentNavigation(page).getByRole('group', { name: 'Agent library', exact: true })).toBeVisible()
  await expect(agentNavigation(page).getByRole('group', { name: 'Agent setup', exact: true })).toBeVisible()
  await expect(page.locator('.topbar')).toHaveCount(0)
  expect(fixture.calls.filter(call => call.op === 'session-list')).toHaveLength(1)
  expect(fixture.calls.some(call => ['session-start', 'launch', 'chat-open'].includes(call.op))).toBe(false)
})

test('old session bookmarks preserve transcript identity and every filter in the combined workspace', async ({ page }) => {
  const fixture = await historyFixture(page)
  const query = '?home=codex%2Fwork&cwd=%2Fprojects%2Fweb&view=all&q=redirect&offset=25'
  await page.goto(`/#/sessions/codex/work/${fixture.sessions[0].id}${query}`)
  await expect(page).toHaveURL(new URL(`/#/agents/sessions/codex/work/${fixture.sessions[0].id}${query}`, page.url()).href)
  await expect(page.getByText('The redirect now uses the original destination.', { exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('redirect')
  await expect.poll(() => fixture.calls.find(call => call.op === 'session-list')?.args).toMatchObject({ home: 'codex/work', cwd: '/projects/web', query: 'redirect', view: 'all', offset: 25 })
  await expect(agentNavigation(page).getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Fix login redirect', exact: true })).toBeVisible()
})

test('switching sections and returning from Home restores filters, selected work, and profile search', async ({ page }) => {
  await historyFixture(page)
  await page.goto('/#/agents/sessions?home=codex%2Fwork&q=redirect')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  const sessionRoute = page.url()
  await openProfiles(page)
  await page.getByRole('searchbox', { name: 'Search profiles' }).fill('work')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const profileRoute = page.url()
  await agentNavigation(page).getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page).toHaveURL(sessionRoute)
  await expect(page.getByRole('heading', { name: 'Fix login redirect', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search sessions' })).toHaveValue('redirect')
  await openProfiles(page)
  await expect(page).toHaveURL(profileRoute)
  await expect(page.getByRole('searchbox', { name: 'Search profiles' })).toHaveValue('work')
  await expect(page.getByRole('region', { name: 'Codex work', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(profileRoute)
  await expect(page.getByRole('region', { name: 'Codex work', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Search profiles' })).toHaveValue('work')
})

test('profile and project filters stay compact and preselect the context for a new session', async ({ page }) => {
  await historyFixture(page)
  await page.goto('/#/agents')
  await sessionFilter(page, 'Profile', 'research · Codex')
  await sessionFilter(page, 'Project', 'server /projects/server')
  await page.getByRole('dialog', { name: 'Filter sessions', exact: true }).getByRole('button', { name: 'Close popover' }).click()
  await expect(page.getByRole('dialog', { name: 'Filter sessions', exact: true })).toBeHidden()
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await expect(page.locator('.session-filter-summary')).toContainText('research · Codex · server')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const form = page.getByRole('region', { name: 'Open terminal', exact: true })
  await expect(form.getByRole('button', { name: /Agent profile$/ })).toContainText('research · Codex')
  await expect(form.getByRole('textbox', { name: 'Project directory', exact: true })).toHaveValue('/projects/server')
})

test('session pagination survives section switches and browser Back and Forward preserve the selected transcript', async ({ page }) => {
  await historyFixture(page, false, 32)
  await page.goto('/#/agents')
  await expect(page.locator('.carrier-message-row')).toHaveCount(25)
  await page.getByRole('button', { name: 'Next sessions' }).click()
  await expect(page.locator('.carrier-message-row')).toHaveCount(10)
  await page.getByRole('button', { name: /Earlier task 22 / }).click()
  await expect(page).toHaveURL(/agents\/sessions\/codex\/work\/extra-22\?offset=25$/)
  const selectedRoute = page.url()
  await openProfiles(page)
  await page.goBack()
  await expect(page).toHaveURL(selectedRoute)
  await expect(page.getByRole('heading', { name: 'Earlier task 22', exact: true })).toBeVisible()
  await expect(page.locator('.carrier-message-row')).toHaveCount(10)
  await page.goForward()
  await expect(page).toHaveURL(/agents\/profiles$/)
  await agentNavigation(page).getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page).toHaveURL(selectedRoute)
})

for (const theme of ['light', 'dark']) test(`combined agent navigation and session filters work with keyboard input in ${theme}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
  await historyFixture(page)
  await page.goto('/#/agents')
  await expect(page.locator('.carrier-message-row')).toHaveCount(3)
  await page.screenshot({ path: test.info().outputPath(`combined-agents-${theme}.png`), animations: 'disabled' })
  await page.getByRole('button', { name: /^Filter sessions/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Filter sessions', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^Filter sessions/ })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open agent navigation' }).click()
  await page.getByRole('dialog', { name: 'Agent navigation' }).getByRole('button', { name: /^Profiles/ }).click()
  await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Open agent navigation' }).click()
  await page.getByRole('dialog', { name: 'Agent navigation' }).getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'All sessions', exact: true })).toBeFocused()
  await expect(page.locator('.carrier-message-row')).toHaveCount(3)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await page.getByRole('button', { name: /^Filter sessions/ }).click()
    await expect(page.getByRole('dialog', { name: 'Filter sessions', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`combined-agents-${theme}-${width}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
  }
})

test('unreadable navigation preferences fall back to Sessions without blocking access', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '{invalid'), AGENT_NAVIGATION_KEY)
  await historyFixture(page)
  await page.goto('/#/agents')
  await expect(page).toHaveURL(/#\/agents\/sessions$/)
  await expect(page.locator('.carrier-message-row')).toHaveCount(3)
})

test('section memory still works for the current visit when storage writes fail', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ last: 'sessions', routes: {} }))
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Storage full', 'QuotaExceededError')
      write.call(this, name, value)
    }
  }, AGENT_NAVIGATION_KEY)
  await historyFixture(page)
  await page.goto('/#/agents')
  await openProfiles(page)
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const selectedRoute = page.url()
  await agentNavigation(page).getByRole('button', { name: 'Sessions', exact: true }).click()
  await openProfiles(page)
  await expect(page).toHaveURL(selectedRoute)
  await expect(page.getByRole('region', { name: 'Codex work', exact: true })).toBeVisible()
})

for (const theme of ['light', 'dark']) test(`saved instructions open inside session details and find older matching runs in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const fixture = await historyFixture(page, false, 0, { older: true })
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  const route = page.url()
  expect(fixture.calls.some(call => call.op === 'prompts-catalog')).toBe(false)
  await page.getByRole('button', { name: 'Session details', exact: true }).click()
  await page.getByRole('button', { name: 'Inspect saved instructions', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Saved instructions', exact: true })
  await expect(dialog.getByRole('heading', { name: 'No saved instructions found', exact: true })).toBeVisible()
  expect(fixture.calls.some(call => call.op === 'prompts-snapshot')).toBe(false)
  await dialog.getByRole('button', { name: 'Load older saved runs', exact: true }).click()
  await expect(dialog.getByLabel('Saved developer instructions', { exact: true })).toHaveText('Review the original changes carefully.')
  expect(fixture.calls.find(call => call.op === 'prompts-history')?.args).toEqual({ consumerId: 'local-codex', offset: 50 })
  expect(fixture.calls.find(call => call.op === 'prompts-snapshot')?.args).toEqual({ consumerId: 'local-codex', launchId: 'saved-run' })
  await expect(page).toHaveURL(route)
  await expect(dialog.getByText('saved-prompt-digest')).toBeHidden()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: test.info().outputPath(`saved-instructions-${theme}-mobile.png`) })
  await page.setViewportSize({ width: 320, height: 844 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await dialog.locator('..').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Session details', exact: true })).toBeFocused()
  await expect(page).toHaveURL(route)
  expect(fixture.calls.some(call => ['session-start', 'launch', 'prompts-bind'].includes(call.op))).toBe(false)
})

test('saved-instruction errors stay inside the session and can be retried', async ({ page }) => {
  const fixture = await historyFixture(page, false, 0, { error: true })
  await page.goto('/#/agents/sessions')
  await page.getByRole('button', { name: /Fix login redirect/ }).click()
  const route = page.url()
  await page.getByRole('button', { name: 'Session details', exact: true }).click()
  await page.getByRole('button', { name: 'Inspect saved instructions', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Saved instructions', exact: true })
  await expect(dialog.getByRole('alert')).toContainText('temporarily unavailable')
  const requests = fixture.calls.filter(call => call.op === 'prompts-snapshot').length
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(call => call.op === 'prompts-snapshot').length).toBe(requests + 1)
  await expect(page).toHaveURL(route)
})
