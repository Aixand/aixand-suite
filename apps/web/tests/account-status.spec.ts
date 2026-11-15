import { test, expect, mockAuthentication, type Page } from './fixtures'
import { agentsRequestSchema } from '../../server/src/agents/protocol'
import type { Profile, AccountObservation } from '../src/agents/client'

const revision = `sha256:${'a'.repeat(64)}`
const personalId = '11111111-1111-4111-8111-111111111111'
const businessId = '22222222-2222-4222-8222-222222222222'

async function accountsFixture(page: Page, provider = 'claude') {
  await mockAuthentication(page)
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const calls: { op: string; args: Record<string, any> }[] = []
  const errors: string[] = []
  let previewError = ''
  page.on('pageerror', error => errors.push(error.message))
  const accounts = [personalId, businessId].map((id, index) => ({ id, name: index ? 'Business' : 'Personal',
    directory: '/fixture/accounts/' + id, owned: true, profiles: index ? [] : ['work'], revision,
    status: { state: 'signed-in', signedIn: true, checkedAt: Date.now() } }))
  const terminal: AccountObservation = { kind: 'native-account', id: personalId, label: 'Personal', scope: 'profile',
    state: 'signed-in', configured: true, statusLabel: 'Signed in', evidence: 'provider-status', checkedAt: Date.now() }
  const chat: AccountObservation = { kind: 'api-key', id: null, label: 'No chat credential selected', scope: 'profile',
    state: 'missing', configured: false, statusLabel: 'Select an account or credential', evidence: 'none' }
  const profiles: Profile[] = [{ id: `${provider}/work`, provider, profile: 'work', auth: null,
    active_runs: 0, authMode: 'native', revision, preferred: true, claude_account: accounts[0],
    authentication: { terminal, chat }, readiness: { ready: true,
      terminal: { ready: true }, chat: { ready: false, reason: 'Select a chat credential' } } }]
  const catalog = { profiles, cwd: '/workspace', auths: [], capabilities: [{ provider, label: provider,
    installed: true, savedModels: true, budgets: false, authMode: 'native', savedAuth: false }] }
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  await page.routeWebSocket('**/api/agents/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw)); if (!command.op) return
      const { id, op, args = {} } = command
      calls.push({ op, args })
      if (!agentsRequestSchema.safeParse(command).success) {
        errors.push('Rejected request: ' + op)
        socket.send(JSON.stringify({ type: 'error', id, message: 'Invalid request' })); return
      }
      let result: unknown = []
      if (op === 'catalog') result = catalog
      if (op === 'sessions') result = { runs: [], runtimeError: null }
      if (op === 'session-list') result = { sessions: [], total: 0, homes: profiles, projects: [], counts: {}, errors: [] }
      if (op === 'agent-operations') result = { operations: [] }
      if (op === 'project-discovery-list') result = { jobs: [] }
      if (op === 'command-list') result = { monitors: [] }
      if (op === 'profile-resources-get') result = { revision, instructions: null, skills: [], mcp: [] }
      if (op === 'launch-preview' && previewError) { socket.send(JSON.stringify({ type: 'error', id, message: previewError })); return }
      if (op === 'launch-preview') result = { report: { items: [] } }
      if (op === 'session-start') result = { session_id: 'terminal-fixture' }
      if (op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      if (op === 'claude-accounts') result = { accounts, migrationRequired: false }
      if (op === 'sdk-credentials-list') result = []
      if (op === 'agent-profile-get') result = profiles.find(row => row.profile === args.profile)
      if (op === 'agent-profile-check') result = { profile: profiles.find(row => row.profile === args.profile) }
      if (op === 'agent-profile-update') {
        const profile = profiles.find(row => row.profile === args.profile)!
        expect(args.expectedRevision).toBe(profile.revision)
        if ('preferred' in args.changes) profile.preferred = args.changes.preferred
        if ('claudeAccountId' in args.changes) {
          profile.claude_account = accounts.find(row => row.id === args.changes.claudeAccountId)!
          profile.authentication!.terminal = { ...terminal, id: profile.claude_account.id, label: profile.claude_account.name }
        }
        profile.revision = `sha256:${'b'.repeat(64)}`
        result = { changed: true, profile }
      }
      if (op === 'create-profile') {
        const account = accounts.find(row => row.id === args.claudeAccountId)!
        const profile: Profile = { ...profiles[0], id: 'claude/' + args.profile, profile: args.profile,
          preferred: false, claude_account: account, authentication: { terminal: { ...terminal, id: account.id, label: account.name }, chat } }
        profiles.push(profile); result = { created: true, profile }
      }
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return { calls, profiles, accounts, errors, setPreviewError: (value: string) => { previewError = value } }
}

test('native account label and terminal/chat readiness are independent', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const connections = page.getByRole('region', { name: 'Profile connections' })
  await expect(connections.getByRole('button', { name: /^Terminal: Personal · Signed in/ })).toBeVisible()
  await expect(connections.getByRole('button', { name: /^Terminal: Personal/ })).toHaveAttribute('data-tone', 'success')
  await expect(connections.getByRole('button', { name: /^Chat: No chat credential selected/ })).toHaveAttribute('data-tone', 'warning')
  await expect(page.getByText('No saved login assigned', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Use unverified profile', { exact: true })).toHaveCount(0)
  await connections.getByRole('button', { name: 'Refresh connection status' }).click()
  await expect.poll(() => fixture.calls.filter(row => row.op === 'agent-profile-check').length).toBe(1)
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('stale account observations stay neutral until checked again', async ({ page }) => {
  const fixture = await accountsFixture(page)
  fixture.profiles[0].authentication!.terminal.stale = true
  fixture.profiles[0].authentication!.terminal.checkedAt = Date.now() - 120_000
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const status = page.getByRole('region', { name: 'Profile connections' }).getByRole('button', { name: /^Terminal: Personal/ })
  await expect(status).toHaveAttribute('data-tone', 'neutral')
  await expect(status).toHaveAttribute('aria-label', /last checked/)
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
})

test('saving a Claude account uses the guarded profile update', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const editor = page.getByRole('region', { name: 'Claude accounts', exact: true })
  await editor.getByRole('button', { name: /Claude account$/ }).and(editor.locator('[aria-haspopup="listbox"]')).click()
  await page.getByRole('option', { name: /^Business/ }).click()
  await editor.getByRole('button', { name: 'Use selected account' }).click()
  await expect.poll(() => fixture.calls.filter(row => row.op === 'agent-profile-update').length).toBe(1)
  expect(fixture.calls.find(row => row.op === 'agent-profile-update')?.args.changes).toEqual({ claudeAccountId: businessId })
  expect(fixture.profiles[0].preferred).toBe(true)
  expect(fixture.errors).toEqual([])
})

test('another profile reuses the preferred native account without signing in again', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  const editor = page.getByRole('region', { name: 'New agent profile' })
  await expect(editor).toContainText('Personal · Claude account')
  await editor.getByLabel('Profile name', { exact: true }).fill('review')
  await editor.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(page).toHaveURL(/profile=claude%2Freview/)
  expect(fixture.calls.find(row => row.op === 'create-profile')?.args).toMatchObject({ profile: 'review', claudeAccountId: personalId })
  expect(fixture.profiles[0].preferred).toBe(true)
  expect(fixture.profiles[1].preferred).toBe(false)
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
  expect(fixture.errors).toEqual([])
})

for (const provider of ['codex', 'claude', 'copilot', 'opencode', 'antigravity']) {
  test(`${provider} opens a terminal with resources while API chat is unavailable`, async ({ page }) => {
    const fixture = await accountsFixture(page, provider)
    await page.goto(`/#/agents/profiles?profile=${provider}%2Fwork`)
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
    const form = page.getByRole('region', { name: 'Open terminal', exact: true })
    await expect(form.getByRole('button', { name: 'Open terminal', exact: true })).toBeEnabled()
    await expect(form.getByRole('checkbox', { name: 'Include Suite tools' })).toBeChecked()
    expect(fixture.calls.find(row => row.op === 'launch-preview')?.args).toMatchObject({ provider, mode: 'terminal', applicationPreset: 'controller' })
    await form.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect.poll(() => fixture.calls.filter(row => row.op === 'session-start').length).toBe(1)
    expect(fixture.calls.find(row => row.op === 'session-start')?.args).toMatchObject({ provider, profile: 'work', expectedRevision: revision, resources: {}, suiteTools: true })
    expect(fixture.calls.some(row => row.op === 'chat-create')).toBe(false)
    expect(fixture.errors).toEqual([])
  })
}

test('a required resource error blocks terminal submission', async ({ page }) => {
  const fixture = await accountsFixture(page)
  fixture.setPreviewError('Required MCP resource unavailable: prepare the project index.')
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  const form = page.getByRole('region', { name: 'Open terminal', exact: true })
  await expect(form.getByRole('alert')).toContainText('Required MCP resource unavailable')
  await expect(form.getByRole('button', { name: 'Open terminal', exact: true })).toBeDisabled()
  expect(fixture.calls.some(row => row.op === 'session-start')).toBe(false)
  expect(fixture.errors).toEqual([])
})


for (const theme of ['light', 'dark'] as const) for (const width of [1440, 390, 320]) {
  test(`connection warnings stay compact and explain recovery on demand in ${theme} at ${width}px`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
    const fixture = await accountsFixture(page)
    fixture.profiles[0].readiness!.chat!.reason = 'Add an API credential in Chat API key to enable chat.'
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/#/agents/profiles?profile=claude%2Fwork')
    const connections = page.getByRole('region', { name: 'Profile connections', exact: true })
    const terminal = connections.getByRole('button', { name: /^Terminal:/ })
    const chat = connections.getByRole('button', { name: /^Chat:/ })
    await expect(terminal).toHaveAttribute('data-tone', 'success')
    await expect(chat).toHaveAttribute('data-tone', 'warning')
    await expect(page.getByText('Add an API credential in Chat API key to enable chat.', { exact: true })).toHaveCount(0)
    await expect(page.locator('.agent-connection-warning, .agent-profile-attention')).toHaveCount(0)
    const before = await connections.boundingBox()
    fixture.profiles[0].authentication!.terminal.state = 'sign-in-required'
    fixture.profiles[0].readiness!.terminal = { ready: false, reason: 'Sign in again from Account actions.' }
    await connections.getByRole('button', { name: 'Refresh connection status' }).click()
    await expect(terminal).toHaveAttribute('data-tone', 'warning')
    const after = await connections.boundingBox()
    expect(after!.height).toBe(before!.height)
    expect((await terminal.boundingBox())!.y).toBe((await chat.boundingBox())!.y)
    await page.keyboard.press('Tab')
    await chat.focus()
    await expect(page.getByRole('tooltip')).toContainText('Add an API credential in Chat API key to enable chat.')
    await chat.click()
    const details = page.getByRole('dialog', { name: 'Chat status', exact: true })
    await expect(details).toContainText('Add an API credential in Chat API key to enable chat.')
    await page.keyboard.press('Escape')
    await expect(details).not.toBeVisible()
    await expect(chat).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/agents-refinements/${theme}-${width}-connections.png` })
    expect(fixture.errors).toEqual([])
  })
}

test('default profile has a labelled switch and preserves guarded updates', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const preferred = page.getByRole('switch', { name: 'Use as default profile', exact: true })
  await expect(preferred).toBeChecked()
  await preferred.click()
  await expect(preferred).not.toBeChecked()
  expect(fixture.calls.find(row => row.op === 'agent-profile-update')?.args.changes).toEqual({ preferred: false })
  expect(fixture.errors).toEqual([])
})

test('large account inventories are searchable and retain account identity when saved', async ({ page }) => {
  const fixture = await accountsFixture(page)
  for (let index = 0; index < 10; index++) fixture.accounts.push({ ...fixture.accounts[1], id: crypto.randomUUID(), name: `Account ${index}` })
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const account = page.getByRole('combobox', { name: 'Claude account', exact: true })
  await account.fill('Business')
  await page.getByRole('option', { name: /^Business/ }).click()
  await page.getByRole('button', { name: 'Use selected account', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(row => row.op === 'agent-profile-update').length).toBe(1)
  expect(fixture.calls.find(row => row.op === 'agent-profile-update')?.args.changes).toEqual({ claudeAccountId: businessId })
  expect(fixture.errors).toEqual([])
})
