import { test, expect, mockAuthentication } from './fixtures'
import type { Page } from './fixtures'
import type { Catalog, Profile, Run } from '../src/agents/client'
import AxeBuilder from '@axe-core/playwright'

async function mockAgents(page: Page, options: { unavailable?: boolean; launchError?: boolean; deleteError?: boolean; deleteFailures?: string[]; holdDeletions?: boolean; cleanupPending?: boolean; holdLoading?: boolean } = {}) {
  await mockAuthentication(page)
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const pendingDeletions: { profile: string; respond: () => void }[] = []
  const heldLoads = new Set(options.holdLoading ? ['catalog', 'profile-resources-get'] : [])
  const pendingLoads: { op: string; respond: () => void }[] = []
  let emit: (value: unknown) => void = () => {}
  const project = { id: 'fixture-project', name: 'Aixand suite', path: '/projects/aixand-suite' }
  const profiles: Profile[] = [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'company', active_runs: 2,
      mcp: { schema: 1, servers: ['sonar'], revision: 'revision-1' } },
    { id: 'opencode/personal', provider: 'opencode', profile: 'personal', auth: 'personal', model: 'provider/model', active_runs: 0 },
    { id: 'codex/default', provider: 'codex', profile: 'default', auth: null, active_runs: 0 },
    { id: 'codex/research', provider: 'codex', profile: 'research', auth: 'personal', active_runs: 1 },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0 },
    { id: 'opencode/sandbox', provider: 'opencode', profile: 'sandbox', auth: null, active_runs: 0 },
  ]
  const runs: Run[] = ['work', 'work', 'research'].map((profile, index) => ({
    run_id: `fixture-${index}`, provider: 'codex', profile, auth: profile === 'work' ? 'company' : 'personal',
    session_id: `session-${index}`, status: 'running', cwd: project.path, active: true,
    created_at_millis: Date.now(), error: null,
    observation: { lifecycle: 'running', execution: 'idle', interaction: 'available', constraint: 'none', health: 'healthy' },
  }))
  const catalog: Catalog = {
    profiles, cwd: project.path,
    capabilities: [
      { provider: 'codex', installed: true, savedModels: false, budgets: true },
      { provider: 'opencode', installed: !options.unavailable, savedModels: true, budgets: false },
    ],
    auths: [
      { provider: 'codex', auth: 'company', verification: 'verified', profiles: ['work', 'review'] },
      { provider: 'codex', auth: 'personal', verification: 'verified', profiles: ['research'] },
      { provider: 'opencode', auth: 'personal', profiles: ['personal'] },
    ],
  }
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    emit = value => socket.send(JSON.stringify(value))
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (!command.op) return
      calls.push(command)
      const args = command.args ?? {}
      const profile = profiles.find((item) => item.provider === args.provider && item.profile === args.profile)
      let result: unknown = {}
      if (command.op === 'profile-resources-get') result = { revision: 'r1', instructions: null, skills: [], mcp: [] }
      if (command.op === 'launch-preview') result = { report: { items: [] } }
      if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      if (command.op === 'catalog') result = catalog
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (command.op === 'project-list') result = [project]
      if (['models', 'chat-list', 'workflow-list', 'prompt-list', 'mcp-jobs'].includes(command.op)) result = []
      if (command.op === 'budgets') result = { supported: true, rows: [{ profile: args.auth, weekly_left: 75 }] }
      if (command.op === 'sessions') result = { runs, runtimeError: null }
      if (command.op === 'session-list') result = { sessions: [], total: 0, homes: [], projects: [], counts: {}, errors: [] }
      if (command.op === 'mcp-catalog') result = { servers: ['sonar', 'lore'].map((name) => ({ name, installed: true })) }
      if (command.op === 'mcp-preview') result = { digest: 'preview', states: [], selection: args.selection }
      if (command.op === 'switch-auth' && profile) profile.auth = args.auth
      if (command.op === 'set-model' && profile) profile.model = args.model
      if (command.op === 'create-profile') profiles.push({ id: `${args.provider}/${args.profile}`,
        provider: args.provider, profile: args.profile, auth: args.auth ?? null, model: args.model, active_runs: 0 })
      if (command.op === 'delete-profile') {
        const respond = () => {
          if (options.deleteError || options.deleteFailures?.includes(`${args.provider}/${args.profile}`) || profile && profile.active_runs > 0) {
            socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: "Stop this profile's active agents in Terminals before deleting it." }))
            return
          }
          expect(args.confirmed).toBe(true)
          expect(args.profile).not.toBe('default')
          const index = profiles.findIndex((item) => item.provider === args.provider && item.profile === args.profile)
          if (index >= 0) profiles.splice(index, 1)
          for (const login of catalog.auths)
            if (login.provider === args.provider) login.profiles = login.profiles.filter((name) => name !== args.profile)
          socket.send(JSON.stringify({ type: 'profiles-changed' }))
          socket.send(JSON.stringify({ type: 'result', id: command.id, result: { deleted: true, cleanupPending: options.cleanupPending } }))
        }
        if (options.holdDeletions) pendingDeletions.push({ profile: args.profile, respond })
        else respond()
        return
      }
      if (command.op === 'mcp-profile-get') result = profile?.mcp ?? { schema: 1, servers: [], revision: 'revision-1' }
      if (command.op === 'mcp-profile-set' && profile) profile.mcp = { schema: 1, servers: args.servers, revision: 'revision-2' }
      if (command.op === 'session-start') {
        if (options.launchError) {
          socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'launch_denied', message: 'The project is unavailable. Choose another directory.' }))
          return
        }
        result = { run_id: 'new-run', session_id: 'new-session' }
      }
      const respond = () => socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (heldLoads.has(command.op)) pendingLoads.push({ op: command.op, respond })
      else respond()
    })
  })
  return { calls, profiles, catalog, runs, pendingDeletions, emit: (value: unknown) => emit(value),
    releaseLoad(op: string) {
      heldLoads.delete(op)
      for (const load of pendingLoads.filter(load => load.op === op)) load.respond()
    },
  }
}

async function selectCheckbox(page: Page, name: string, checked = true) {
  const checkbox = page.getByRole('checkbox', { name, exact: true })
  if (await checkbox.isChecked() !== checked) await page.locator('label').filter({ has: checkbox }).click()
  await expect(checkbox).toBeChecked({ checked })
}

for (const width of [1440, 1000, 390]) test(`profile names retain their width through loading at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  const fixture = await mockAgents(page, { holdLoading: true })
  await page.goto('/#/agents/profiles?profile=codex%2Fwork')
  await expect(page.locator('.carrier-message-scroll .page-loading').getByRole('status')).toHaveText('Loading profiles…')
  await page.evaluate(() => {
    const samples: { row: number; available: number; lines: number }[] = []
    let frame = 0
    function sample() {
      for (const row of document.querySelectorAll<HTMLElement>('.agent-profile-row > .carrier-message-row')) {
        if (!row.checkVisibility()) continue
        const title = row.querySelector('.carrier-row-title')!
        const range = document.createRange()
        range.selectNodeContents(title)
        samples.push({ row: row.getBoundingClientRect().width,
          available: row.closest('.carrier-message-scroll')!.clientWidth,
          lines: range.getClientRects().length })
      }
      frame = requestAnimationFrame(sample)
    }
    frame = requestAnimationFrame(sample)
    Object.assign(window, { stopAgentLoadingSamples: () => { cancelAnimationFrame(frame); return samples } })
  })
  fixture.releaseLoad('catalog')
  const details = page.getByRole('region', { name: 'Codex work', exact: true })
  await expect(details.getByRole('heading', { name: 'work', exact: true })).toBeVisible()
  await expect(details.getByRole('region', { name: 'Profile defaults', exact: true })).toBeVisible()
  expect(fixture.calls.some(call => call.op === 'profile-resources-get')).toBe(false)
  const readerWidth = (await page.locator('.carrier-reader').boundingBox())!.width
  fixture.releaseLoad('profile-resources-get')
  await expect(details.getByText('Loading profile settings…', { exact: true })).toHaveCount(0)
  expect((await page.locator('.carrier-reader').boundingBox())!.width).toBeCloseTo(readerWidth)
  if (width <= 760) await page.getByRole('button', { name: 'Back to profiles', exact: true }).click()
  await expect(page.getByRole('button', { name: 'work · Codex', exact: true })).toBeVisible()
  const samples = await page.evaluate(() => (window as unknown as {
    stopAgentLoadingSamples: () => { row: number; available: number; lines: number }[]
  }).stopAgentLoadingSamples())
  expect(samples.length).toBeGreaterThan(0)
  for (const sample of samples) {
    expect(Math.abs(sample.row - sample.available)).toBeLessThan(1)
    expect(sample.lines).toBe(1)
  }
})

test('Carrier-style workspace attaches to the app rail and supports compact profile search', async ({ page }) => {
  await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Select an agent profile' })).toBeVisible()
  const rail = await page.locator('.navigation-rail').boundingBox()
  const sidebar = await page.locator('.carrier-sidebar').boundingBox()
  const main = await page.locator('#main-content').boundingBox()
  expect(sidebar!.x).toBeCloseTo(rail!.x + rail!.width)
  expect(sidebar!.y).toBeCloseTo(main!.y)
  expect(sidebar!.y + sidebar!.height).toBeCloseTo(main!.y + main!.height)
  await page.getByRole('searchbox', { name: 'Search profiles' }).fill('research')
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'research · Codex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Codex research' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/agents-workspace/profiles.png' })
})

test('profile editing stays in the reader and saves the selected login', async ({ page }) => {
  const { calls } = await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const form = page.getByRole('region', { name: 'Account', exact: true })
  await form.getByRole('button', { name: /Saved account$/ }).click()
  await page.getByRole('option', { name: /^personal/ }).click()
  await form.getByRole('button', { name: 'Save account', exact: true }).click()
  await expect.poll(() => calls.find((call) => call.op === 'switch-auth')?.args.auth).toBe('personal')
  await expect(page.getByRole('region', { name: 'Codex work' })).toContainText('personal')
})

test('profile creation and launch use inline forms and retain launch overrides', async ({ page }) => {
  const { calls } = await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'New agent profile' }).getByRole('button', { name: /Provider$/ })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Customize this session' }).click()
  await page.getByRole('textbox', { name: 'Model override', exact: true }).fill('custom-model')
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect.poll(() => calls.find((call) => call.op === 'session-start')?.args).toMatchObject({ profile: 'work', expectedAuth: 'company', model: 'custom-model' })
  await expect(page).toHaveURL(/terminals\/new-session/)
})

test('active and native profiles retain deletion protection', async ({ page }) => {
  await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'default · Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for default' }).click()
  await expect(page.getByRole('menuitem', { name: 'Delete profile', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for work', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete work?' })
  await expect(dialog.getByRole('button', { name: 'Delete profile', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Open Terminals', exact: true }).click()
  await expect(page).toHaveURL(/terminals\/session-0/)
})

test('deletion supports cancellation and server rejection without losing the profile', async ({ page }) => {
  const { calls } = await mockAgents(page, { deleteError: true })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  await page.getByRole('button', { name: 'Actions for review', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete review?' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(calls.filter((call) => call.op === 'delete-profile')).toHaveLength(0)
  await page.getByRole('button', { name: 'Actions for review', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('active agents in Terminals')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'review · Codex', exact: true })).toBeVisible()
})

test('profile deletion lives in the selected profile menu and restores focus on cancellation', async ({ page }) => {
  const fixture = await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await expect(page.getByRole('button', { name: /Delete Codex profile/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  const menu = page.getByRole('button', { name: 'Actions for review', exact: true })
  await menu.click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete review?', exact: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(menu).toBeFocused()
  expect(fixture.calls.filter(call => call.op === 'delete-profile')).toHaveLength(0)
  await menu.click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'review · Codex', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Select an agent profile', exact: true })).toBeVisible()
  expect(fixture.catalog.auths).toHaveLength(3)
})


test('batch profile deletion confirms the full provider identities and preserves saved logins', async ({ page }) => {
  const fixture = await mockAgents(page, { cleanupPending: true })
  fixture.profiles.push({ id: 'opencode/review', provider: 'opencode', profile: 'review', auth: 'personal', active_runs: 0 })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  await selectCheckbox(page, 'review · Codex')
  await selectCheckbox(page, 'review · OpenCode')
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete 2 profiles?', exact: true })
  await expect(dialog.getByRole('listitem')).toHaveText(['reviewCodex', 'reviewOpenCode'])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(fixture.calls.filter(call => call.op === 'delete-profile')).toHaveLength(0)
  await expect(page.getByRole('checkbox', { name: 'review · Codex', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete profiles', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'review · Codex', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'review · OpenCode', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Profile library actions', exact: true })).toBeFocused()
  await expect(page.locator('.carrier-notice')).toContainText('2 profiles deleted. Some local files could not be removed.')
  expect(fixture.calls.filter(call => call.op === 'delete-profile').map(call => call.args)).toEqual([
    { provider: 'codex', profile: 'review', confirmed: true }, { provider: 'opencode', profile: 'review', confirmed: true },
  ])
  expect(fixture.catalog.auths).toHaveLength(3)
})

test('select all applies to the filtered profiles and retains selections across filters', async ({ page }) => {
  await mockAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await page.getByRole('button', { name: /Filter by provider$/ }).click()
  await page.getByRole('option', { name: 'Codex', exact: true }).click()
  await selectCheckbox(page, 'Select all visible profiles')
  await expect(page.getByRole('checkbox', { name: 'review · Codex', exact: true })).toBeChecked()
  await page.getByRole('button', { name: /Filter by provider$/ }).click()
  await page.getByRole('option', { name: 'OpenCode', exact: true }).click()
  await selectCheckbox(page, 'Select all visible profiles')
  await expect(page.getByRole('group', { name: 'Profile selection' })).toContainText('3 selected · 1 hidden by filters')
  await selectCheckbox(page, 'Select all visible profiles', false)
  await expect(page.getByRole('group', { name: 'Profile selection' })).toContainText('1 selected · 1 hidden by filters')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Cancel profile selection', exact: true }).click()
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Profile selection' })).toContainText('0 selected')
})

test('batch selection protects native profiles, running agents, and background servers', async ({ page }) => {
  const fixture = await mockAgents(page)
  fixture.runs.push({ ...fixture.runs[0], run_id: 'background', provider: 'opencode', profile: 'sandbox', mode: 'app-server' })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'default · Codex', exact: true })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: 'work · Codex', exact: true })).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: 'sandbox · OpenCode', exact: true })).toBeDisabled()
  await selectCheckbox(page, 'review · Codex')
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete 1 profile?', exact: true })
  fixture.profiles.find(profile => profile.id === 'codex/review')!.active_runs = 1
  fixture.emit({ type: 'profiles-changed' })
  await expect(dialog.getByRole('button', { name: 'Delete profile', exact: true })).toBeDisabled()
  await expect(dialog).toContainText('Stop active agents')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  await selectCheckbox(page, 'review · Codex', false)
  expect(fixture.calls.filter(call => call.op === 'delete-profile')).toHaveLength(0)
})

test('partial batch failures retain only failed profiles and retry without repeating successful deletions', async ({ page }) => {
  const deleteFailures = ['codex/review']
  const fixture = await mockAgents(page, { deleteFailures })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await selectCheckbox(page, 'Select all visible profiles')
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete 3 profiles?', exact: true })
  await dialog.getByRole('button', { name: 'Delete profiles', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('2 deleted · 1 could not be deleted')
  await expect(dialog.getByRole('button', { name: 'Retry remaining', exact: true })).toBeEnabled()
  deleteFailures.length = 0
  await dialog.getByRole('button', { name: 'Retry remaining', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.carrier-notice')).toContainText('3 profiles deleted.')
  expect(fixture.calls.filter(call => call.op === 'delete-profile').map(call => `${call.args.provider}/${call.args.profile}`)).toEqual([
    'opencode/personal', 'codex/review', 'opencode/sandbox', 'codex/review',
  ])
})

test('a pending batch prevents duplicate requests and cannot be dismissed halfway through', async ({ page }) => {
  const fixture = await mockAgents(page, { holdDeletions: true })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  await selectCheckbox(page, 'personal · OpenCode')
  await selectCheckbox(page, 'review · Codex')
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete 2 profiles?', exact: true })
  await dialog.getByRole('button', { name: 'Delete profiles', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
  await expect.poll(() => fixture.pendingDeletions.length).toBe(1)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'delete-profile')).toHaveLength(1)
  fixture.pendingDeletions.shift()!.respond()
  await expect.poll(() => fixture.pendingDeletions.length).toBe(1)
  expect(fixture.pendingDeletions[0].profile).toBe('review')
  fixture.pendingDeletions.shift()!.respond()
  await expect(dialog).toHaveCount(0)
  expect(fixture.calls.filter(call => call.op === 'delete-profile')).toHaveLength(2)
})

for (const [width, theme] of [[320, 'light'], [390, 'dark']] as const) test(`batch selection supports keyboard and accessible confirmation at ${width}px`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  await mockAgents(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select profiles', exact: true }).click()
  const review = page.getByRole('checkbox', { name: 'review · Codex', exact: true })
  await review.focus()
  await page.keyboard.press('Space')
  await expect(review).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select all visible profiles', exact: true })).toHaveJSProperty('indeterminate', true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: `artifacts/profile-selection/${width}-selection.png` })
  const listWidth = (await page.locator('.carrier-list-pane').boundingBox())!.width
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete 1 profile?', exact: true })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await page.locator('.carrier-list-pane').boundingBox())!.width).toBeCloseTo(listWidth)
  await page.screenshot({ path: `artifacts/profile-selection/${width}-confirmation.png` })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeFocused()
})

for (const theme of ['light', 'dark']) test(`responsive workspace keeps navigation and forms accessible in ${theme}`, async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('aixand.appearance', theme), theme)
  await mockAgents(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agents/profiles')
  const row = page.getByRole('button', { name: 'work · Codex', exact: true })
  await row.click()
  await expect(page.locator('.carrier-list-pane')).toBeHidden()
  await page.getByRole('button', { name: 'Back to profiles' }).click()
  await expect(row).toBeFocused()
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Provider$/ })).toBeVisible()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `artifacts/agents-workspace/${theme}-mobile.png` })
})

