import { test, expect, type Page, type WebSocketRoute } from './fixtures'
import { agentsRequestSchema } from '../../aixand-server/src/agents/protocol'
import type { Catalog, SdkCredential } from '../src/agents/client'

const revision = `sha256:${'a'.repeat(64)}`

test('Claude account creation binds a provider-owned directory without subscription tokens', async ({ page }) => {
  const fixture = await sdkAgents(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  await page.getByRole('button', { name: /^Account / }).click()
  const form = page.getByRole('region', { name: 'Claude accounts', exact: true })
  await form.getByLabel('New account name', { exact: true }).fill('Personal')
  await form.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(form).toContainText('Account created. Sign in through Claude to continue.')
  await expect(form.getByRole('button', { name: 'Sign in through Claude', exact: true })).toBeVisible()
  expect(fixture.calls.find(call => call.op === 'claude-account-create')?.args.name).toBe('Personal')
  expect(fixture.calls.find(call => call.op === 'claude-account-bind')?.args.accountId).toBe(fixture.accounts[0].id)
  expect(fixture.calls.some(call => call.op === 'import-login')).toBe(false)
  expect(fixture.rejected).toEqual([])
  await page.screenshot({ path: '/tmp/aixand-claude-native-auth/claude-accounts.png' })
})

test('Claude account status refreshes automatically and shared sign-out requires review', async ({ page }) => {
  const fixture = await sdkAgents(page)
  const account = { id: '11111111-1111-4111-8111-111111111111', name: 'Existing', directory: '/home/user/.claude',
    owned: false, profiles: ['work'], revision, status: { state: 'unchecked', signedIn: false } }
  fixture.accounts.push(account)
  fixture.catalog.profiles[0].claude_account = account
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  await page.getByRole('button', { name: /^Account / }).click()
  const form = page.getByRole('region', { name: 'Claude accounts', exact: true })
  await expect(form).toContainText('Signed in')
  expect(fixture.calls.filter(call => call.op === 'claude-account-check')).toHaveLength(1)
  await form.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(form).toContainText('This also signs out other applications using this directory.')
  expect(fixture.calls.filter(call => call.op === 'claude-account-logout')).toHaveLength(0)
  await form.getByRole('button', { name: 'Confirm sign-out', exact: true }).click()
  await expect(form).toContainText('Sign-in required')
  expect(fixture.calls.find(call => call.op === 'claude-account-logout')?.args).toMatchObject({ accountId: account.id, confirmed: true })
  expect(fixture.rejected).toEqual([])
})

test('Claude saved-login migration is explicit and explains fresh sign-in', async ({ page }) => {
  const fixture = await sdkAgents(page)
  fixture.requireMigration()
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  await page.getByRole('button', { name: /^Account / }).click()
  const form = page.getByRole('region', { name: 'Claude accounts', exact: true })
  await form.getByRole('button', { name: 'Migrate saved Claude logins', exact: true }).click()
  await expect(form).toContainText('Accounts will need official sign-in again.')
  expect(fixture.calls.some(call => call.op === 'claude-account-migrate')).toBe(false)
  await form.getByRole('button', { name: 'Confirm migration', exact: true }).click()
  await expect(form.getByRole('button', { name: 'Create account', exact: true })).toBeVisible()
  expect(fixture.calls.find(call => call.op === 'claude-account-migrate')?.args.confirmed).toBe(true)
  expect(fixture.rejected).toEqual([])
})

async function sdkAgents(page: Page, fail: (attempt: number) => boolean = () => false) {
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const rejected: string[] = []
  const attempts: WebSocketRoute[] = []
  const credentials: SdkCredential[] = []
  const accounts: { id: string; name: string; directory: string; owned: boolean; revision: string; profiles: string[];
    status: { state: string; signedIn: boolean; email?: string; checkedAt?: number } }[] = []
  let migrationRequired = false
  const catalog: Catalog = { cwd: '/workspace', auths: [],
    profiles: ['claude', 'antigravity'].map(provider => ({ id: `${provider}/work`, provider, profile: 'work', auth: null, active_runs: 0 })) as Catalog['profiles'],
    capabilities: ['claude', 'antigravity'].map(provider => ({ provider, installed: true, savedModels: false, budgets: false, authMode: 'native' })) as Catalog['capabilities'],
  }
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  await page.routeWebSocket('**/api/agents/ws', socket => {
    let seen = false
    let closed = false
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      if (closed) return
      if (!seen) { seen = true; attempts.push(socket) }
      if (fail(attempts.length)) {
        closed = true
        socket.close({ code: 1011, reason: 'Fixture disconnected after ready' })
        return
      }
      const command = JSON.parse(String(raw))
      calls.push(command)
      // Use the real gateway validator: permissive UI mocks missed this loop.
      if (!agentsRequestSchema.safeParse(command).success) {
        rejected.push(command.op)
        closed = true
        socket.close({ code: 1008, reason: 'Invalid agent request' })
        return
      }
      const { id, op, args } = command
      let result: unknown = []
      if (op === 'catalog') result = catalog
      if (op === 'claude-accounts') result = { accounts, migrationRequired }
      if (op === 'claude-account-create') {
        const account = { id: crypto.randomUUID(), name: args.name, directory: args.directory ?? '/managed/claude/accounts/personal',
          owned: !args.directory, revision, profiles: [], status: { state: 'unchecked', signedIn: false } }
        accounts.push(account); result = account
      }
      if (op === 'claude-account-bind') {
        const profile = catalog.profiles.find(row => row.provider === 'claude' && row.profile === args.profile)!
        profile.claude_account = accounts.find(row => row.id === args.accountId) ?? null
        for (const account of accounts) account.profiles = profile.claude_account?.id === account.id ? [profile.profile] : []
        result = { changed: true }
      }
      if (op === 'claude-account-check') {
        const account = accounts.find(row => row.id === args.accountId)!
        account.status = { state: 'signed-in', signedIn: true, email: 'fixture@example.test', checkedAt: Date.now() }; result = account
      }
      if (op === 'claude-account-logout') {
        const account = accounts.find(row => row.id === args.accountId)!
        account.status = { state: 'sign-in-required', signedIn: false, checkedAt: Date.now() }; result = account
      }
      if (op === 'claude-account-migrate') { migrationRequired = false; result = { migrated: true } }
      if (op === 'agent-operations') result = { operations: [] }
      if (op === 'project-discovery-list') result = { jobs: [] }
      if (op === 'sessions') result = { runs: [], runtimeError: null }
      if (op === 'session-list') result = { sessions: [], total: 0, nextOffset: null,
        homes: catalog.profiles, projects: [], counts: { all: 0, running: 0, attention: 0, archived: 0 }, errors: [] }
      if (op === 'mcp-catalog') result = { servers: [] }
      if (op === 'profile-resources-get') result = { revision, instructions: null, skills: [], mcp: [] }
      if (op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
      if (op === 'sdk-credentials-list') result = credentials.filter(row => row.provider === args.provider)
      if (op === 'agent-profile-get') result = { revision }
      if (op === 'backend-discovery-refresh') result = { id: 'profile-discovery', epoch: 'fixture', generation: id, sequence: 1,
        sourceRevision: revision, provider: args.provider, profile: args.profile, backend: args.backend, state: 'ready', discoveredAt: Date.now(),
        models: [], settings: [], commands: [], limitations: [], error: '' }
      if (op === 'sdk-credential-save') {
        const saved: SdkCredential = { id: `${args.provider}/${args.name}`, provider: args.provider, name: args.name, method: 'api-key', revision }
        credentials.push(saved); result = saved
      }
      if (op === 'sdk-credential-assign') {
        const profile = catalog.profiles.find(row => row.provider === args.provider && row.profile === args.profile)!
        profile.sdk_credential = credentials.find(row => row.provider === args.provider && row.name === args.name) ?? null
        if (profile.provider === 'claude') profile.sdk_authentication = 'api-key'
        result = profile
      }
      if (op === 'sdk-auth-configure') {
        const profile = catalog.profiles.find(row => row.provider === args.provider && row.profile === args.profile)!
        profile.sdk_authentication = args.method
        result = { method: args.method }
      }
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return { calls, rejected, attempts, accounts, catalog, requireMigration: () => { migrationRequired = true } }
}

for (const provider of ['claude', 'antigravity'] as const) {
  test(`${provider} profile discovery is explicit and leaves chat history unchanged`, async ({ page }) => {
    const fixture = await sdkAgents(page)
    await page.goto(`/#/agents/profiles?profile=${provider}%2Fwork`)
    await page.getByRole('button', { name: /^Account / }).click()
    const title = provider === 'claude' ? 'SDK authentication' : 'Chat API credentials'
    await page.getByRole('button', { name: /^Chat authentication/ }).click()
    const form = page.getByRole('region', { name: title, exact: true })
    expect(fixture.calls.some(call => call.op.startsWith('backend-discovery-'))).toBe(false)
    await form.getByRole('button', { name: 'Refresh discovery', exact: true }).click()
    await expect(form.getByRole('status')).toContainText('Discovered at')
    expect(fixture.calls.find(call => call.op === 'backend-discovery-refresh')?.args).toMatchObject({ provider, profile: 'work', backend: `${provider}-sdk` })
    expect(fixture.calls.some(call => ['chat-create', 'chat-send', 'chat-config-set'].includes(call.op))).toBe(false)
    expect(fixture.rejected).toEqual([])
  })

  test(`${provider} profile history and SDK credential assignment pass the gateway contract without disconnecting`, async ({ page }) => {
    const fixture = await sdkAgents(page)
    await page.goto(`/#/agents/profiles?profile=${provider}%2Fwork`)
    await expect.poll(() => fixture.calls.some(call => call.op === 'session-list' && call.args.home === `${provider}/work`)).toBe(true)
    await expect(page.locator('.carrier-connection-status')).toHaveText('Connected')
    await page.getByRole('button', { name: /^Account / }).click()
    const title = provider === 'claude' ? 'SDK authentication' : 'Chat API credentials'
    await page.getByRole('button', { name: /^Chat authentication/ }).click()
    const form = page.getByRole('region', { name: title, exact: true })
    await form.getByLabel('Credential name', { exact: true }).fill('work-api')
    await form.getByLabel(provider === 'claude' ? 'Anthropic API key' : 'Gemini API key', { exact: true }).fill('fixture-not-a-real-api-key')
    await form.getByRole('button', { name: 'Save and assign API key', exact: true }).click()
    await expect(form.getByRole('status')).toHaveText('API credential saved and assigned.')
    await expect(form.getByLabel(provider === 'claude' ? 'Anthropic API key' : 'Gemini API key', { exact: true })).toHaveValue('')
    expect(fixture.calls.find(call => call.op === 'sdk-credential-assign')?.args).toEqual({ provider, profile: 'work', name: 'work-api', expectedRevision: revision })
    await form.getByRole('button', { name: /Assigned credential$/ }).click()
    await page.getByRole('option', { name: 'None', exact: true }).click()
    await form.getByRole('button', { name: provider === 'claude' ? 'Save chat authentication' : 'Save assignment', exact: true }).click()
    await expect(form.getByRole('status')).toHaveText(provider === 'claude' ? 'API credential authentication selected for new SDK chats.' : 'API credential assignment saved.')
    expect(fixture.calls.filter(call => call.op === 'sdk-credential-assign').at(-1)?.args.name).toBe(null)
    await page.getByRole('button', { name: 'Account connection', exact: true }).click()
    await page.getByRole('button', { name: 'work', exact: true }).click()
    await page.getByRole('button', { name: 'View sessions', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`agents/sessions\\?home=${provider}%2Fwork`))
    await expect(page.getByRole('heading', { name: 'No sessions here', exact: true })).toBeVisible()
    await expect(page.locator('.carrier-connection-status')).toHaveText('Connected')
    expect(fixture.rejected).toEqual([])
    expect(fixture.attempts).toHaveLength(1)
  })
}

test('Claude SDK profile login can be selected without an API key, persists after reload, and can switch back explicitly', async ({ page }) => {
  const fixture = await sdkAgents(page)
  async function open() {
    await page.getByRole('button', { name: /^Account / }).click()
    await page.getByRole('button', { name: /^Chat authentication/ }).click()
    return page.getByRole('region', { name: 'SDK authentication', exact: true })
  }
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  let form = await open()
  await form.getByLabel('Anthropic API key', { exact: true }).fill('discard-this-unsaved-fixture-key')
  await form.getByRole('button', { name: /Authentication method$/ }).click()
  await page.getByRole('option', { name: 'Use the selected Claude account', exact: true }).click()
  await expect(form.getByText(/Claude manages sign-in and credentials/)).toBeVisible()
  await expect(form.getByLabel('Anthropic API key', { exact: true })).toHaveCount(0)
  await form.getByRole('button', { name: 'Save chat authentication', exact: true }).click()
  await expect(form.getByRole('status')).toHaveText('Claude Code login selected for new SDK chats.')
  expect(fixture.calls.find(call => call.op === 'sdk-auth-configure')?.args).toEqual({ provider: 'claude', profile: 'work', method: 'profile-login', expectedRevision: revision })
  expect(fixture.calls.filter(call => ['sdk-credential-save', 'sdk-credential-assign'].includes(call.op))).toEqual([])
  await page.reload()
  form = await open()
  await expect(form.getByRole('button', { name: /Authentication method$/ })).toContainText('Use the selected Claude account')
  await form.getByRole('button', { name: /Authentication method$/ }).click()
  await page.getByRole('option', { name: 'Use an API credential', exact: true }).click()
  await form.getByRole('button', { name: 'Save chat authentication', exact: true }).click()
  await expect(form.getByRole('status')).toHaveText('API credential authentication selected for new SDK chats.')
  await expect(form.getByLabel('Anthropic API key', { exact: true })).toBeVisible()
  await expect(form.getByLabel('Anthropic API key', { exact: true })).toHaveValue('')
  await expect(page.locator('.carrier-connection-status')).toHaveText('Connected')
  expect(fixture.rejected).toEqual([])
})

test('ready followed by repeated disconnection stops after three retries and allows an explicit reconnect', async ({ page }) => {
  let failing = true
  const fixture = await sdkAgents(page, () => failing)
  await page.goto('/#/agents/profiles')
  await expect.poll(() => fixture.attempts.length, { timeout: 15000 }).toBe(4)
  await expect(page.locator('.carrier-connection-status')).toHaveText('Disconnected')
  await page.waitForTimeout(2200)
  expect(fixture.attempts).toHaveLength(4)
  failing = false
  await page.getByRole('button', { name: 'Agent Manager connection', exact: true }).click()
  await page.locator('.carrier-connection-details').getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.locator('.carrier-connection-status')).toHaveText('Connected')
  expect(fixture.attempts).toHaveLength(5)
  expect(fixture.rejected).toEqual([])
})

test('a stable connection restores the retry budget for a later outage', async ({ page }) => {
  test.setTimeout(45000)
  let laterOutage = false
  const fixture = await sdkAgents(page, attempt => attempt <= 2 || laterOutage)
  await page.goto('/#/agents/profiles')
  await expect(page.locator('.carrier-connection-status')).toHaveText('Connected', { timeout: 10000 })
  await expect.poll(() => fixture.attempts.length).toBe(3)
  await page.waitForTimeout(10500)
  laterOutage = true
  fixture.attempts.at(-1)!.close({ code: 1011, reason: 'Later fixture outage' })
  await expect.poll(() => fixture.attempts.length, { timeout: 15000 }).toBe(6)
  await expect(page.locator('.carrier-connection-status')).toHaveText('Disconnected')
  await page.waitForTimeout(2200)
  expect(fixture.attempts).toHaveLength(6)
  expect(fixture.rejected).toEqual([])
})
