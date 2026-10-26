import { test, expect, mockAuthentication, type Page } from './fixtures'
import { agentsRequestSchema } from '../../aixand-server/src/agents/protocol'
import type { Profile, AccountObservation } from '../src/agents/client'

const revision = `sha256:${'a'.repeat(64)}`
const personalId = '11111111-1111-4111-8111-111111111111'
const businessId = '22222222-2222-4222-8222-222222222222'

async function accountsFixture(page: Page) {
  await mockAuthentication(page)
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const calls: { op: string; args: Record<string, any> }[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const accounts = [personalId, businessId].map((id, index) => ({ id, name: index ? 'Business' : 'Personal',
    directory: '/fixture/accounts/' + id, owned: true, profiles: index ? [] : ['work'], revision,
    status: { state: 'signed-in', signedIn: true, checkedAt: Date.now() } }))
  const terminal: AccountObservation = { kind: 'native-account', id: personalId, label: 'Personal', scope: 'profile',
    state: 'signed-in', configured: true, statusLabel: 'Signed in', evidence: 'provider-status', checkedAt: Date.now() }
  const chat: AccountObservation = { kind: 'api-key', id: null, label: 'No chat credential selected', scope: 'profile',
    state: 'missing', configured: false, statusLabel: 'Select an account or credential', evidence: 'none' }
  const profiles: Profile[] = [{ id: 'claude/work', provider: 'claude', profile: 'work', auth: null,
    active_runs: 0, authMode: 'native', revision, preferred: true, claude_account: accounts[0],
    authentication: { terminal, chat }, readiness: { ready: true,
      terminal: { ready: true }, chat: { ready: false, reason: 'Select a chat credential' } } }]
  const catalog = { profiles, cwd: '/workspace', auths: [], capabilities: [{ provider: 'claude', label: 'Claude',
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
  return { calls, profiles, errors }
}

test('native account label and terminal/chat readiness are independent', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  const connections = page.getByRole('region', { name: 'Profile connections' })
  await expect(connections).toContainText('Terminal: Personal')
  await expect(connections).toContainText('Signed in')
  await expect(connections).toContainText('Chat: No chat credential selected')
  await expect(page.getByText('No saved login assigned', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Use unverified profile', { exact: true })).toHaveCount(0)
  await connections.getByRole('button', { name: 'Refresh connection status' }).click()
  await expect.poll(() => fixture.calls.filter(row => row.op === 'agent-profile-check').length).toBe(1)
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('saving a Claude account uses the guarded profile update', async ({ page }) => {
  const fixture = await accountsFixture(page)
  await page.goto('/#/agents/profiles?profile=claude%2Fwork')
  await page.getByRole('button', { name: /^Account Personal/ }).click()
  const editor = page.getByRole('region', { name: 'Claude accounts', exact: true })
  await editor.getByRole('button', { name: /Claude account$/ }).click()
  await page.getByRole('option', { name: 'Business', exact: true }).click()
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
