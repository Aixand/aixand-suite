import { test, expect, mockAuthentication } from './fixtures'
import type { Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { AgentJob, Budget, Catalog, ProviderInfo, Sessions } from '../src/agents/client'


async function loginAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'Saved login actions', exact: true }).click()
  return page.getByRole('menuitem', { name: new RegExp('^' + name) })
}
async function profileAction(page: Page, name = 'Rename profile') {
  await page.getByRole('button', { name: /^Actions for / }).click()
  return page.getByRole('menuitem', { name: new RegExp('^' + name) })
}
async function removalFor(page: Page, name: string, provider = 'Codex') {
  await page.locator('.carrier-message-row').filter({ hasText: provider }).getByText(name, { exact: true }).click()
  await (await loginAction(page, 'Remove saved login')).click()
  return page.getByRole('region', { name: 'Remove ' + name + '?', exact: true })
}

test('native profile without legacy authentication can refresh its connection status', async ({ page }) => {
  const fixture = await operationalAgents(page)
  const profile = fixture.catalog.profiles[0]
  profile.authMode = 'native'
  profile.auth = null
  profile.readiness = { ready: false, verification: 'unchecked', reason: 'Sign in to this native profile.', terminal: { ready: false, verification: 'unchecked' } }
  fixture.catalog.capabilities[0].authMode = 'native'
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const connections = page.getByRole('region', { name: 'Profile connections', exact: true })
  await expect(connections).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up provider', exact: true })).toHaveCount(0)
  profile.readiness = { ready: true, verification: 'verified', reason: null }
  await connections.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(call => call.op === 'agent-profile-check').length).toBe(1)
  expect(fixture.calls.find(call => call.op === 'agent-profile-check')?.args).toEqual({ provider: 'codex', profile: 'work' })
  await expect(connections.getByRole('button', { name: 'Account access verified', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Use as default profile' })).toBeVisible()
})
async function providerAction(page: Page, provider: string, name: string) {
  await page.getByRole('button', { name: provider + ' actions', exact: true }).click()
  return page.getByRole('menuitem', { name, exact: true })
}

test('dark profile management preserves rename protection and returns focus to its action menu', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await expect(page.getByRole('button', { name: '1 running session', exact: true })).toBeVisible()
  await expect(page.locator('.agents-delete-trigger')).toBeHidden()
  await expect(page.getByRole('region', { name: 'Profile resource defaults', exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Actions for work', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^Rename profile/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText("Stop this profile's running agents to rename it.", { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Actions for work', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  const deletion = page.getByRole('alertdialog', { name: 'Delete work?', exact: true })
  await expect(deletion.getByRole('button', { name: 'Delete profile', exact: true })).toBeDisabled()
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Actions for work', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  const actions = page.getByRole('button', { name: 'Actions for review', exact: true })
  await actions.click()
  await page.getByRole('menuitem', { name: 'Rename profile', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Profile name', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(actions).toBeFocused()
  expect(fixture.calls.filter(call => ['rename-profile', 'delete-profile', 'agent-operation-start', 'profile-resources-set'].includes(call.op))).toHaveLength(0)
})

test('dark saved-login overview keeps assignment and reauthentication explicit and restores focus', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  const fixture = await operationalAgents(page)
  fixture.catalog.profiles[0].active_runs = 0
  fixture.catalog.auths[0].verification = 'verified'
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  const overview = page.getByRole('region', { name: 'company', exact: true })
  await expect(overview.getByRole('button', { name: /Account access verified/ })).toBeVisible()
  await expect(overview.getByRole('button', { name: /Sign-in method$/ })).toHaveCount(0)
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await overview.getByRole('button', { name: 'Assign to profiles', exact: true }).click()
  await page.getByRole('checkbox', { name: 'review', exact: true }).focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Save assignments', exact: true }).click()
  expect(fixture.calls.find(call => call.op === 'switch-auth')?.args).toMatchObject({ provider: 'codex', profile: 'review', auth: 'company' })
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await (await loginAction(page, 'Rename login')).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overview.getByRole('button', { name: 'Saved login actions', exact: true })).toBeFocused()
  await (await loginAction(page, 'Sign in again')).click()
  const signIn = page.getByRole('region', { name: 'Sign in to company', exact: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overview.getByRole('button', { name: 'Saved login actions', exact: true })).toBeFocused()
  await (await loginAction(page, 'Sign in again')).click()
  await signIn.getByRole('button', { name: /Sign-in method$/ }).click()
  await page.getByRole('option', { name: 'Browser', exact: true }).click()
  await signIn.getByRole('button', { name: 'Sign in again', exact: true }).click()
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'codex', auth: 'company', kind: 'reauthenticate', device: false, structured: false })
  await signIn.getByRole('button', { name: 'Cancel operation', exact: true }).click()
  await signIn.getByRole('button', { name: 'Retry operation', exact: true }).click()
  const starts = fixture.calls.filter(call => call.op === 'agent-operation-start')
  expect(starts).toHaveLength(2)
  expect(starts[0].args.key).not.toBe(starts[1].args.key)
})

test('dark account checking starts a check without changing assignments or starting sign-in', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  const overview = page.getByRole('region', { name: 'company', exact: true })
  await expect(overview.getByRole('button', { name: /Account access not checked/ })).toBeVisible()
  await overview.getByRole('button', { name: 'Check login', exact: true }).click()
  await expect(overview).toContainText('Complete sign-in in the terminal.')
  const starts = fixture.calls.filter(call => call.op === 'agent-operation-start')
  expect(starts).toHaveLength(1)
  expect(starts[0].args).toMatchObject({ provider: 'codex', auth: 'company', kind: 'check-login' })
  expect(starts[0].args.device).toBeUndefined()
  expect(fixture.calls.filter(call => ['switch-auth', 'rename-login', 'remove-login'].includes(call.op))).toHaveLength(0)
  fixture.complete(fixture.jobs[0])
  fixture.catalog.auths[0].verification = 'failed'
  await page.reload()
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await expect(overview.getByRole('button', { name: 'Account check failed', exact: true })).toBeVisible()
  await overview.getByRole('button', { name: 'Sign in again', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Sign in to company', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(overview.getByRole('button', { name: 'Sign in again', exact: true })).toBeFocused()
})

test('an external account result refreshes an open login even while a stale catalog request is pending', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  const fixture = await operationalAgents(page)
  fixture.catalog.auths[0].verification = 'unsupported'
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  const overview = page.getByRole('region', { name: 'company', exact: true })
  await expect(overview.getByRole('button', { name: /Account verification unavailable/ })).toBeVisible()
  fixture.holdNextCatalog()
  fixture.emit({ type: 'profiles-changed' })
  await expect.poll(fixture.catalogPending).toBe(true)
  fixture.catalog.auths[0].verification = 'verified'
  fixture.emit({ type: 'profiles-changed' })
  fixture.releaseCatalog()
  await expect(overview.getByRole('button', { name: /Account access verified/ })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

async function operationalAgents(page: Page, options: { removeError?: boolean; budgetRows?: Budget[] } = {}) {
  await mockAuthentication(page)
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const jobs: AgentJob[] = []
  const sessions: Sessions = { runs: [], runtimeError: null }
  const catalog: Catalog = { cwd: '/projects/suite', capabilities: [
    { provider: 'codex', installed: true, budgets: true, savedModels: false },
    { provider: 'opencode', installed: false, budgets: false, savedModels: true },
  ], profiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'company', active_runs: 1 },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: null, active_runs: 0 },
    { id: 'codex/default', provider: 'codex', profile: 'default', auth: null, active_runs: 0 },
  ], auths: [{ provider: 'codex', auth: 'company', profiles: ['work'] }] }
  const providers: ProviderInfo[] = [
    { provider: 'codex', installed: true, version: '1.2.3', method: 'npm', path: '/tools/codex', canUpdate: true,
      error: null, activeProfiles: ['work'], methods: [{ id: 'npm', label: 'npm', error: null }] },
    { provider: 'opencode', installed: false, version: null, method: null, path: null, canUpdate: false,
      error: 'Provider not installed.', activeProfiles: [], methods: [
        { id: 'npm', label: 'npm', error: null }, { id: 'installer', label: 'Official installer', error: null },
      ] },
  ]
  for (const provider of providers) provider.setup = { docs: 'https://example.test/installation', verifyCommand: `${provider.provider} --version`,
    methods: provider.methods.map(method => ({ ...method, command: `npm install -g ${provider.provider}` })) }
  let sendEvent = (_event: object) => {}
  let holdCatalog = false
  let pendingCatalog: (() => void) | null = null
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    sendEvent = (event) => socket.send(JSON.stringify(event))
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (!command.op) return
      calls.push(command)
      const args = command.args ?? {}
      let result: unknown = {}
      if (command.op === 'catalog' && holdCatalog) {
        holdCatalog = false
        const response = JSON.stringify({ type: 'result', id: command.id, result: catalog })
        pendingCatalog = () => { socket.send(response); pendingCatalog = null }
        return
      }
      if (command.op === 'profile-resources-get') result = { revision: 'r1', instructions: null, skills: [], mcp: [] }
      if (command.op === 'resource-catalog') result = { integrations: {}, choices: { instructions: [], skills: [], mcp: [] } }
      if (command.op === 'models') result = []
      if (command.op === 'catalog') result = catalog
      if (command.op === 'agent-operations') result = { operations: jobs }
      if (command.op === 'providers') result = { providers, environment: {
        os: 'linux', label: 'Linux', architecture: 'x64', wsl: false, tools: ['node', 'npm', 'curl'], managedSupported: true,
      } }
      if (command.op === 'sessions') result = sessions
      if (command.op === 'session-list') result = { sessions: [], homes: [], projects: [], counts: {}, errors: [], total: 0 }
      if (command.op === 'project-list') result = []
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (['chat-list', 'workflow-list', 'mcp-jobs'].includes(command.op)) result = []
      if (command.op === 'mcp-catalog') result = { servers: [] }
      if (command.op === 'budgets') result = { supported: true, rows: options.budgetRows ?? [{ profile: args.auth, weekly_left: 75 }] }
      if (command.op === 'agent-operation-start') {
        const job: AgentJob = { id: args.key, provider: args.provider, auth: args.auth, profile: args.profile, kind: args.kind, method: args.method,
          versionTarget: args.versionTarget,
          status: args.kind === 'update' ? 'queued' : 'running', sessionId: args.kind === 'update' ? null : 'operation-terminal',
          message: args.kind === 'update' ? 'Waiting for active agents to finish.' : 'Complete sign-in in the terminal.',
          createdAt: Date.now(), updatedAt: Date.now(), cancellable: args.kind !== 'update', device: args.device }
        jobs.unshift(job); result = job
        sendEvent({ type: 'agent-operation-updated', operation: job })
      }
      if (command.op === 'agent-operation-cancel') {
        const job = jobs.find((job) => job.id === args.operationId)!
        job.status = 'cancelled'; job.message = 'Operation cancelled.'; result = job
        sendEvent({ type: 'agent-operation-updated', operation: job })
      }
      if (command.op === 'switch-auth') {
        const profile = catalog.profiles.find((profile) => profile.provider === args.provider && profile.profile === args.profile)!
        profile.auth = args.auth
        for (const login of catalog.auths) login.profiles = catalog.profiles
          .filter((profile) => profile.provider === login.provider && profile.auth === login.auth).map((profile) => profile.profile)
      }
      if (command.op === 'create-profile') {
        if (!catalog.profiles.some(row => row.provider === args.provider && row.profile === args.profile)) {
          catalog.profiles.push({ id: `${args.provider}/${args.profile}`, provider: args.provider, profile: args.profile, auth: args.auth ?? null,
            identity: `identity-${args.provider}-${args.profile}`, active_runs: 0 })
        }
        for (const login of catalog.auths) login.profiles = catalog.profiles.filter(row => row.provider === login.provider && row.auth === login.auth).map(row => row.profile)
        result = { profile: { identity: `identity-${args.provider}-${args.profile}` } }
      }
      if (command.op === 'rename-login') {
        const login = catalog.auths.find((login) => login.provider === args.provider && login.auth === args.auth)!
        login.auth = args.newName
        for (const profile of catalog.profiles) if (profile.auth === args.auth) profile.auth = args.newName
      }
      if (command.op === 'remove-login') {
        if (options.removeError) {
          socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'Could not remove the saved login. Try again.' }))
          return
        }
        expect(args.confirmed).toBe(true)
        catalog.auths = catalog.auths.filter((login) => login.provider !== args.provider || login.auth !== args.auth)
      }
      if (command.op === 'rename-profile') {
        const profile = catalog.profiles.find((profile) => profile.profile === args.profile)!
        profile.profile = args.newName; profile.id = `${args.provider}/${args.newName}`
      }
      if (command.op === 'duplicate-profile') {
        const original = catalog.profiles.find((profile) => profile.profile === args.profile)!
        catalog.profiles.push({ ...original, profile: args.newName, id: `${args.provider}/${args.newName}`, active_runs: 0 })
      }
      if (command.op === 'provider-check-updates') {
        const provider = providers.find((provider) => provider.provider === args.provider)!
        provider.latestVersion = '1.2.4'; provider.checkedAt = Date.now(); result = provider
      }
      if (command.op === 'provider-diagnostics') result = { checkedAt: Date.now(), checks: [
        { label: 'Provider executable', status: 'passed', message: 'Version 1.2.3' },
        { label: 'Terminal connection', status: 'passed', message: 'Connected.' },
      ] }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  return { calls, catalog, jobs, sessions, providers,
    holdNextCatalog: () => { holdCatalog = true }, catalogPending: () => pendingCatalog !== null,
    releaseCatalog: () => { if (!pendingCatalog) throw new Error('No catalog response is pending'); pendingCatalog() },
    emit: (event: object) => sendEvent(event), complete: (job: AgentJob) => {
    job.status = 'succeeded'; job.updatedAt = Date.now(); job.message = 'Operation completed.'
    if (job.kind === 'install') {
      const provider = providers.find(row => row.provider === job.provider)!
      Object.assign(provider, { installed: true, usable: true, version: '2.0.0', error: null, method: job.method ?? 'npm' })
      catalog.capabilities.find(row => row.provider === job.provider)!.installed = true
    } else if (job.kind === 'install-sdk') {
      const provider = providers.find(row => row.provider === job.provider)!
      provider.sdkInstallations = provider.sdkInstallations?.map(sdk => ({ ...sdk, available: true, version: sdk.requiredVersion, error: null }))
    } else if (job.kind === 'profile-login') {
      catalog.profiles.find(row => row.provider === job.provider && row.profile === job.profile)!.readiness = { ready: true, verification: 'unsupported' }
      job.result = { verification: 'unsupported' }
    } else {
      if (!catalog.auths.some((auth) => auth.provider === job.provider && auth.auth === job.auth))
        catalog.auths.push({ provider: job.provider, auth: job.auth!, profiles: [], verification: 'verified' })
      if (job.kind === 'check-login') catalog.auths.find(row => row.provider === job.provider && row.auth === job.auth)!.verification = 'verified'
      job.result = { ...job.result, verification: job.result?.verification ?? 'verified', loginSaved: true }
    }
    sendEvent({ type: 'agent-operation-updated', operation: job }); sendEvent({ type: 'profiles-changed' })
  } }
}

async function section(page: Page, title: string) {
  await expect(page.locator('.carrier-workspace')).toBeVisible()
  if (!(await page.locator('.carrier-sidebar').isVisible())) await page.getByRole('button', { name: 'Open agent navigation' }).click()
  const navigation = await page.locator('.carrier-sidebar').isVisible() ? page.locator('.carrier-sidebar') : page.getByRole('dialog', { name: 'Agent navigation', exact: true })
  const target = navigation.getByRole('button', { name: new RegExp('^' + title) })
  if (!(await target.isVisible())) await navigation.getByRole('button', { name: ['Providers', 'Saved logins'].includes(title) ? 'Setup' : 'Configuration', exact: true }).click()
  await target.click()
}

test('providers show installed Claude and Antigravity CLI and SDK versions independently', async ({ page }) => {
  const fixture = await operationalAgents(page)
  for (const provider of ['claude', 'antigravity'] as const) fixture.providers.push({
    provider, installed: true, version: provider === 'claude' ? '2.1.302' : '1.4.0',
    method: provider === 'claude' ? 'installer' : 'standalone', path: `/tools/${provider}`, canUpdate: false,
    error: null, activeProfiles: [], methods: [], maintenanceNote: 'CLI installation and updates are managed outside Suite.',
    sdkInstallations: [{ backend: `${provider}-sdk`, label: provider === 'claude' ? 'Claude SDK' : 'Antigravity SDK',
      package: provider === 'claude' ? 'claude-agent-sdk' : 'google-antigravity',
      version: provider === 'claude' ? '0.2.168' : '0.1.22', requiredVersion: provider === 'claude' ? '0.2.168' : '0.1.22',
      installer: 'uv', available: true, error: null }],
  })
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  for (const [label, cliVersion, method, sdkVersion] of [
    ['Claude', '2.1.302', 'Official installer', '0.2.168'],
    ['Antigravity', '1.4.0', 'Standalone executable', '0.1.22'],
  ]) {
    const displayName = label === 'Antigravity' ? 'Antigravity (agy)' : label
    await expect(page.getByRole('button', { name: displayName, exact: true })).toContainText('Installed for chat and terminal')
    await providerDetails(page, displayName)
    const details = page.getByRole('region', { name: displayName, exact: true })
    await expect(details).toContainText(cliVersion)
    await expect(details).toContainText(method)
    await expect(details.getByRole('region', { name: `${label} SDK installation`, exact: true })).toContainText(sdkVersion)
    await expect(details).toContainText('Available for chat')
    await expect(details).toContainText('uv · server environment')
    await expect(details).not.toContainText("Use the provider's official installer")
    await expect(details.getByRole('button', { name: 'Update', exact: true })).toBeDisabled()
    await expect(await providerAction(page, displayName, 'Repair installation')).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('menuitem', { name: 'Check for updates', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('menuitem', { name: 'Check setup', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  }
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('SDK availability stays separate from a missing CLI and an incompatible SDK version', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers.push({ provider: 'claude', installed: false, version: null, method: null, path: null,
    canUpdate: false, error: 'CLI executable not found.', activeProfiles: [], methods: [], sdkInstallations: [{
      backend: 'claude-sdk', label: 'Claude SDK', package: 'claude-agent-sdk', version: '0.2.168',
      requiredVersion: '0.2.168', installer: 'pip', available: true, error: null,
    }] })
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  const row = page.getByRole('button', { name: 'Claude', exact: true })
  await expect(row).toContainText('Installed for chat · Terminal not installed')
  await providerDetails(page, 'Claude')
  await expect(page.getByRole('region', { name: 'Claude SDK installation', exact: true })).toContainText('Available for chat')
  await page.getByRole('button', { name: 'Install Claude Code', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Install automatically', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  fixture.providers.at(-1)!.sdkInstallations![0] = { ...fixture.providers.at(-1)!.sdkInstallations![0],
    version: '0.2.167', available: false, error: 'Install the required SDK version in the server environment.' }
  await page.reload()
  await section(page, 'Providers')
  await providerDetails(page, 'Claude')
  const sdk = page.getByRole('region', { name: 'Claude SDK installation', exact: true })
  await expect(sdk).toContainText('Unavailable for chat')
  await expect(sdk).toContainText('0.2.167')
  await expect(sdk).toContainText('Required version')
  await expect(sdk).toContainText('0.2.168')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('login operation survives closing and reload, then supports assignment', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'New login', exact: true }).click()
  const form = page.getByRole('region', { name: 'New saved login', exact: true })
  await form.getByRole('textbox', { name: 'Login name' }).fill('personal')
  await form.getByRole('button', { name: 'Start sign-in' }).click()
  await expect(form).toContainText('Open the terminal to continue signing in.')
  await form.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /^Operations 1/ })).toBeVisible()
  fixture.complete(fixture.jobs[0])
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'personal', exact: true }).click()
  await page.getByRole('button', { name: 'Assign to profiles', exact: true }).click()
  await page.getByRole('checkbox', { name: 'review', exact: true }).focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Save assignments', exact: true }).click()
  expect(fixture.calls.find((call) => call.op === 'switch-auth')?.args).toMatchObject({ profile: 'review', auth: 'personal' })
})

for (const provider of ['claude', 'antigravity'] as const) {
  test(`${provider} displays each account allowance window and unavailable data`, async ({ page }) => {
    const fixture = await operationalAgents(page, { budgetRows: [
      { profile: 'personal', bucket: 'session', label: 'Session allowance', window: 'session', remaining_percent: 40,
        weekly_left: null, checked_at: 1800000000, resets_at: 4102444800 },
      { profile: 'personal', bucket: 'weekly', label: 'Weekly allowance', window: 'weekly', remaining_percent: null,
        weekly_left: null, checked_at: 1800000000, resets_at: null },
    ] })
    fixture.catalog.capabilities.push({ provider, installed: true, budgets: true, savedModels: true,
      savedAuth: true, authMode: 'files' })
    fixture.catalog.auths.push({ provider, auth: 'personal', profiles: [] })
    await page.goto('/#/agents/logins')
    await expect(page.getByRole('button', { name: 'personal', exact: true })).toContainText('Account access not checked')
    await page.getByRole('button', { name: 'personal', exact: true }).click()
    await page.getByRole('button', { name: /^Allowance and activity/ }).click()
    const detail = page.getByRole('region', { name: 'Account allowance windows' })
    await expect(detail).toContainText('Session allowance')
    await expect(detail).toContainText('40% remaining')
    await expect(detail).toContainText('Weekly allowance')
    await expect(detail).toContainText('Unavailable')
    await expect(detail).not.toContainText('100%')
    await page.getByRole('button', { name: 'Check allowance', exact: true }).click()
    expect(fixture.calls.some(call => call.op === 'budgets' && call.args.provider === provider)).toBe(true)
  })

  test(`${provider} saved login uses a terminal flow and assigns only its provider profiles`, async ({ page }) => {
    const fixture = await operationalAgents(page)
    fixture.catalog.capabilities.push({ provider, installed: true, budgets: false, savedModels: true,
      savedAuth: true, authMode: 'files' })
    fixture.catalog.profiles.push({ id: `${provider}/local`, provider, profile: 'local', auth: null, active_runs: 0 })
    await page.goto('/#/agents/logins')
    await page.getByRole('button', { name: 'New login', exact: true }).click()
    const form = page.getByRole('region', { name: 'New saved login', exact: true })
    await form.getByRole('button', { name: /Provider$/ }).click()
    await page.getByRole('option', { name: provider === 'claude' ? 'Claude' : 'Antigravity (agy)', exact: true }).click()
    await expect(form.getByRole('button', { name: /Sign-in method$/ })).toHaveCount(0)
    if (provider === 'antigravity') await expect(form).toContainText('enter /exit in Antigravity')
    await form.getByRole('textbox', { name: 'Login name' }).fill('personal')
    await form.getByRole('button', { name: 'Start sign-in' }).click()
    const start = fixture.calls.find(call => call.op === 'agent-operation-start')!
    expect(start.args).toMatchObject({ provider, kind: 'new-login', auth: 'personal' })
    expect(start.args.device).toBeUndefined()
    expect(start.args.structured).toBeUndefined()
    fixture.jobs[0].result = { loginSaved: true, verification: 'unsupported', credentialPresent: true }
    fixture.complete(fixture.jobs[0])
    fixture.catalog.auths.find(login => login.provider === provider)!.verification = 'unsupported'
    await form.getByRole('button', { name: 'Assign to profiles', exact: true }).click()
    const assignments = page.getByRole('region', { name: 'Assign to profiles', exact: true })
    await expect(assignments.getByRole('checkbox', { name: 'review', exact: true })).toHaveCount(0)
    await assignments.getByRole('checkbox', { name: 'local', exact: true }).focus()
    await page.keyboard.press('Space')
    await assignments.getByRole('button', { name: 'Save assignments', exact: true }).click()
    expect(fixture.calls.find(call => call.op === 'switch-auth')?.args).toMatchObject({ provider, profile: 'local', auth: 'personal' })
    await page.getByRole('button', { name: 'personal', exact: true }).click()
    await expect(page.getByRole('region', { name: 'personal', exact: true }).getByRole('button', { name: /Login saved locally/ })).toBeVisible()
  })
}

test('Antigravity uses shared native sign-in and is excluded from saved-login creation', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.capabilities.push({ provider: 'antigravity', installed: true, budgets: false,
    savedModels: true, savedAuth: false, authMode: 'native', homeScope: 'shared' })
  fixture.catalog.profiles.push({ id: 'antigravity/work', provider: 'antigravity', profile: 'work', auth: null, active_runs: 0 })
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'New login', exact: true }).click()
  const login = page.getByRole('region', { name: 'New saved login', exact: true })
  await login.getByRole('button', { name: /Provider$/ }).click()
  await expect(page.getByRole('option', { name: 'Antigravity (agy)', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await login.getByRole('button', { name: 'Cancel', exact: true }).click()
  await section(page, 'Profiles')
  await page.getByRole('button', { name: 'work · Antigravity (agy)', exact: true }).click()
  const form = page.getByRole('region', { name: 'Account', exact: true })
  await expect(form).toContainText('Sign-in is shared across this provider’s profiles')
  await expect(form.getByRole('button', { name: 'New login', exact: true })).toHaveCount(0)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'antigravity', profile: 'work', kind: 'profile-login' })
})

test('a profile keeps its context while connecting a login in a dialog', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  const profile = page.getByRole('region', { name: 'Account', exact: true })
  await profile.getByRole('button', { name: 'Account actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connect another account', exact: true }).click()
  const login = page.getByRole('dialog', { name: 'New saved login', exact: true })
  await login.getByRole('textbox', { name: 'Login name' }).fill('inline-login')
  await login.getByRole('button', { name: 'Start sign-in' }).click()
  fixture.complete(fixture.jobs[0])
  await login.getByRole('button', { name: 'Use this login' }).click()
  await profile.getByRole('button', { name: 'Save account', exact: true }).click()
  expect(fixture.calls.find((call) => call.op === 'switch-auth')?.args).toMatchObject({ profile: 'review', auth: 'inline-login' })
})

test('opening a login is passive and reauthentication can cancel and retry', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  expect(fixture.calls.filter((call) => call.op === 'agent-operation-start')).toHaveLength(0)
  await (await loginAction(page, 'Sign in again')).click()
  const form = page.getByRole('region', { name: 'Sign in to company', exact: true })
  await form.getByRole('button', { name: 'Sign in again' }).click()
  await form.getByRole('button', { name: 'Cancel operation' }).click()
  await expect(form).toContainText('Operation cancelled.')
  await form.getByRole('button', { name: 'Retry operation' }).click()
  await expect(form).toContainText('Open the terminal to continue signing in.')
  const starts = fixture.calls.filter((call) => call.op === 'agent-operation-start')
  expect(starts).toHaveLength(2)
  expect(starts[0].args.key).not.toBe(starts[1].args.key)
})

test('imported login supports renaming and explicit removal', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'Saved login library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import local login' }).click()
  await page.getByRole('textbox', { name: 'Login name' }).fill('imported')
  await page.getByRole('button', { name: 'Import login', exact: true }).click()
  fixture.complete(fixture.jobs[0])
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'imported', exact: true }).click()
  await (await loginAction(page, 'Rename login')).click()
  await page.getByRole('textbox', { name: 'Login name' }).fill('renamed')
  await page.getByRole('button', { name: 'Save name' }).click()
  await page.getByRole('button', { name: 'renamed', exact: true }).click()
  await (await loginAction(page, 'Remove saved login')).click()
  const removal = page.getByRole('region', { name: 'Remove renamed?', exact: true })
  await removal.getByRole('button', { name: 'Remove saved login', exact: true }).click()
  expect(fixture.calls.find((call) => call.op === 'remove-login')?.args.confirmed).toBe(true)
  await expect(page.getByRole('button', { name: 'renamed', exact: true })).toHaveCount(0)
})

test('saved-login menu deletion supports cancellation, rejection, and retry', async ({ page }) => {
  const options = { removeError: true }
  const fixture = await operationalAgents(page, options)
  fixture.catalog.auths.push({ provider: 'codex', auth: 'spare', profiles: [] })
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'spare', exact: true }).click()
  const remove = page.getByRole('button', { name: 'Saved login actions', exact: true })
  await (await loginAction(page, 'Remove saved login')).click()
  const form = page.getByRole('region', { name: 'Remove spare?', exact: true })
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(remove).toBeFocused()
  expect(fixture.calls.filter(call => call.op === 'remove-login')).toHaveLength(0)
  await (await loginAction(page, 'Remove saved login')).click()
  await form.getByRole('button', { name: 'Remove saved login', exact: true }).click()
  await expect(form.getByRole('alert')).toContainText('Could not remove the saved login')
  await expect(page.getByRole('button', { name: 'spare', exact: true })).toBeVisible()
  options.removeError = false
  await form.getByRole('button', { name: 'Remove saved login', exact: true }).click()
  await expect(page.getByRole('button', { name: 'spare', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Saved login library actions', exact: true })).toBeFocused()
  expect(fixture.calls.filter(call => call.op === 'remove-login').map(call => call.args)).toEqual([
    { provider: 'codex', auth: 'spare', confirmed: true }, { provider: 'codex', auth: 'spare', confirmed: true },
  ])
})

test('saved-login deletion protects active and background sessions and requires clearing assignments', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.profiles.find(profile => profile.profile === 'review')!.auth = 'assigned'
  fixture.catalog.auths.push(
    { provider: 'codex', auth: 'assigned', profiles: ['review'] },
    { provider: 'codex', auth: 'previous', profiles: [] },
    { provider: 'codex', auth: 'retained', profiles: [] },
    { provider: 'opencode', auth: 'company', profiles: [] },
  )
  const background = { run_id: 'background', provider: 'codex' as const, profile: 'work', auth: 'previous',
    session_id: 'background-session', status: 'running', active: false, cwd: null, created_at_millis: null, error: null,
    mode: 'app-server' as const, observation: { lifecycle: 'running', execution: 'idle', interaction: 'available', constraint: 'none', health: 'healthy' } }
  fixture.sessions.runs.push(background, { ...background, run_id: 'exited', auth: 'retained', active: true,
    observation: { ...background.observation, lifecycle: 'exited' } })
  await page.goto('/#/agents/logins')
  for (const [name, provider, protectedLogin] of [['company', 'Codex', true], ['previous', 'Codex', true], ['retained', 'Codex', false], ['company', 'OpenCode', false]] as const) {
    const removal = await removalFor(page, name, provider)
    if (protectedLogin) await expect(removal.getByRole('button', { name: 'Remove saved login', exact: true })).toBeDisabled()
    else await expect(removal.getByRole('button', { name: 'Remove saved login', exact: true })).toBeEnabled()
    await removal.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await removalFor(page, 'assigned')
  const assigned = page.getByRole('region', { name: 'Remove assigned?', exact: true })
  await expect(assigned.getByRole('button', { name: 'Remove saved login', exact: true })).toBeDisabled()
  await expect(assigned).toContainText('Unassign or replace this login')
  await assigned.getByRole('button', { name: 'Manage assignments', exact: true }).click()
  const assignments = page.getByRole('region', { name: 'Assign to profiles', exact: true })
  await assignments.getByRole('checkbox', { name: 'review', exact: true }).focus()
  await page.keyboard.press('Space')
  await assignments.getByRole('button', { name: 'Save assignments', exact: true }).click()
  await removalFor(page, 'assigned')
  await assigned.getByRole('button', { name: 'Remove saved login', exact: true }).click()
  await expect(page.getByRole('button', { name: 'assigned', exact: true })).toHaveCount(0)
  expect(fixture.calls.filter(call => call.op === 'remove-login').map(call => call.args.auth)).toEqual(['assigned'])
  await removalFor(page, 'retained')
  const retained = page.getByRole('region', { name: 'Remove retained?', exact: true })
  const review = fixture.catalog.profiles.find(profile => profile.profile === 'review')!
  review.auth = 'retained'; review.active_runs = 1
  fixture.emit({ type: 'profiles-changed' })
  await expect(retained.getByRole('button', { name: 'Remove saved login', exact: true })).toBeDisabled()
  await retained.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit())
  expect(fixture.calls.filter(call => call.op === 'remove-login')).toHaveLength(1)
})

for (const [width, theme] of [[320, 'light'], [390, 'dark']] as const) test(`contextual delete actions and confirmations fit ${width}px in ${theme}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), theme)
  const fixture = await operationalAgents(page)
  fixture.catalog.auths.push({ provider: 'codex', auth: 'spare-with-a-long-name', profiles: [] })
  await page.setViewportSize({ width, height: 900 })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  const removeProfile = page.getByRole('button', { name: 'Actions for review', exact: true })
  await removeProfile.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Delete profile', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete review?', exact: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(removeProfile).toBeFocused()
  await page.goto('/#/agents/logins')
  await removalFor(page, 'spare-with-a-long-name')
  const removeLogin = page.getByRole('button', { name: 'Saved login actions', exact: true })
  const form = page.getByRole('region', { name: 'Remove spare-with-a-long-name?', exact: true })
  await expect(form).toBeVisible()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(removeLogin).toBeFocused()
})

test('provider maintenance queues until idle and supports installation and diagnostics', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  await (await providerAction(page, 'Codex', 'Check for updates')).click()
  await expect(page.getByRole('region', { name: 'Codex', exact: true })).toContainText('1.2.4')
  await page.getByRole('button', { name: 'Update', exact: true }).click()
  await page.getByRole('button', { name: 'Update when idle' }).click()
  expect(fixture.calls.find((call) => call.op === 'agent-operation-start')?.args).toMatchObject({ kind: 'update', whenIdle: true })
  await page.getByRole('button', { name: 'Cancel operation' }).click()
  await providerDetails(page, 'OpenCode')
  await page.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  expect(fixture.calls.filter((call) => call.op === 'agent-operation-start')[1]?.args).toMatchObject({ kind: 'install', provider: 'opencode' })
  await expect(page.getByRole('progressbar', { name: 'Installing', exact: true })).toBeVisible()
  const installing = fixture.jobs.find(job => job.kind === 'install')!
  installing.progress = { schema: 'agent-manager/install-progress-1', stage: 'verifying', label: 'Verifying installed version',
    steps: { completed: 2, total: 3 } }
  fixture.emit({ type: 'agent-operation-updated', operation: installing })
  await expect(page.getByRole('progressbar', { name: 'Verifying installed version', exact: true })).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByText('2 of 3 installation steps complete', { exact: true })).toBeVisible()
  await providerDetails(page, 'Codex')
  await (await providerAction(page, 'Codex', 'Check setup')).click()
  await expect(page.getByRole('region', { name: 'Check setup Codex' })).toContainText('Terminal connection')
})

function softwareFixture(changes: Partial<NonNullable<ProviderInfo['software']>> = {}): NonNullable<ProviderInfo['software']> {
  return { disabled: false, bundled: false, revision: `sha256:${'a'.repeat(64)}`, automatic: true,
    reason: null, method: 'installer', path: '/home/user/.local/bin/codex', targets: ['/home/user/.local/bin/codex'],
    manualCommands: ['rm -f /home/user/.local/bin/codex'], manualSteps: ['Open a terminal on the Suite host.', 'Remove the CLI.'],
    docs: 'https://learn.chatgpt.com/docs/codex/cli', preservesAccounts: true, ...changes }
}

test('automatic CLI removal requires review and sends the reviewed installation identity', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers[0].software = softwareFixture()
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  await page.getByRole('button', { name: 'Uninstall CLI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Uninstall automatically', exact: true }).click()
  const review = page.getByRole('region', { name: 'Uninstall Codex CLI', exact: true })
  await expect(review).toContainText('Saved accounts, profiles and project files are preserved')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await review.getByRole('button', { name: 'Confirm uninstall CLI', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(call => call.op === 'agent-operation-start').length).toBe(1)
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({
    provider: 'codex', kind: 'uninstall', confirmed: true, whenIdle: true, installationRevision: softwareFixture().revision,
  })
  await expect(review.getByRole('progressbar', { name: 'Removing CLI' })).toBeVisible()
  expect(fixture.catalog.profiles).toHaveLength(3)
})

test('manual uninstall shows instructions without executing an operation', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers[0].software = softwareFixture({ automatic: false, reason: 'Installation owner could not be verified.' })
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  await page.getByRole('button', { name: 'Uninstall CLI', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Uninstall automatically' })).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('menuitem', { name: 'Uninstall manually', exact: true }).click()
  const manual = page.getByRole('region', { name: 'Manually uninstall Codex', exact: true })
  await expect(manual).toContainText('rm -f /home/user/.local/bin/codex')
  await manual.getByRole('button', { name: 'Check installation', exact: true }).click()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

for (const disabled of [false, true]) test(`bundled provider can be ${disabled ? 'restored' : 'disabled'} without removing its files`, async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers[0].software = softwareFixture({ bundled: true, disabled, automatic: false })
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  await expect(page.getByRole('button', { name: 'Uninstall CLI', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: disabled ? 'Restore provider' : 'Disable bundled provider', exact: true }).click()
  await page.getByRole('button', { name: disabled ? 'Confirm restore provider' : 'Confirm disable provider', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(call => call.op === 'agent-operation-start').length).toBe(1)
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ kind: disabled ? 'enable' : 'disable', confirmed: true })
  expect(fixture.catalog.auths).toHaveLength(1)
})

for (const method of [null, 'bundled']) test(`bundled Windows CLI has a clear installation method with backend value ${method}`, async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers[0].software = softwareFixture({ bundled: true, automatic: false })
  fixture.providers[0].method = method
  fixture.providers[0].canUpdate = false
  fixture.providers[0].path = 'C:\\Users\\User\\AppData\\Local\\Aixand\\runtime\\bin\\codex.exe'
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  const details = page.getByRole('region', { name: 'Codex', exact: true })
  const accordion = details.getByRole('button', { name: 'Installation details', exact: true })
  if (await accordion.getAttribute('aria-expanded') !== 'true') await accordion.click()
  await expect(details).toContainText('Bundled with Aixand')
  await expect(details).not.toContainText('Not detected')
  const repair = details.getByRole('button', { name: 'Repair installation', exact: true })
  if (await repair.count()) await expect(repair).toBeDisabled()
  else {
    await details.getByRole('button', { name: 'Codex actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Repair installation', exact: true })).toHaveAttribute('aria-disabled', 'true')
  }
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('profile renaming and duplication update the list and protect the native profile', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex' }).click()
  await page.getByRole('button', { name: 'Actions for review' }).click()
  await page.getByRole('menuitem', { name: 'Rename profile' }).click()
  await page.getByRole('textbox', { name: 'Profile name' }).fill('renamed')
  await page.getByRole('button', { name: 'Save name' }).click()
  await page.getByRole('button', { name: 'renamed · Codex' }).click()
  await page.getByRole('button', { name: 'Actions for renamed' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate profile' }).click()
  await page.getByRole('button', { name: 'Duplicate profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed-copy · Codex' })).toBeVisible()
  expect(fixture.calls.filter((call) => ['rename-profile', 'duplicate-profile'].includes(call.op))).toHaveLength(2)
})

for (const theme of ['light', 'dark']) test(`management panes are accessible on mobile in ${theme}`, async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('aixand.appearance', theme), theme)
  await operationalAgents(page)
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#/agents/profiles')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'New login', exact: true }).click()
  await expect(page.getByRole('region', { name: 'New saved login' })).toBeVisible()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Back to saved logins' }).click()
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  await page.getByRole('button', { name: 'Update', exact: true }).click()
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await page.setViewportSize({ width: 320, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('visible profile rename validates names and preserves selection after saving and reload', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  await (await profileAction(page)).click()
  const form = page.getByRole('region', { name: 'Rename review', exact: true })
  const input = form.getByRole('textbox', { name: 'Profile name', exact: true })
  const save = form.getByRole('button', { name: 'Save name', exact: true })
  await expect(save).toBeDisabled()
  await input.fill('work')
  await expect(form).toContainText('That name is already in use for this provider.')
  await expect(save).toBeDisabled()
  await input.fill('default')
  await expect(save).toBeDisabled()
  await input.fill('new review')
  await expect(save).toBeDisabled()
  await input.fill('renamed-review')
  await save.click()
  await expect(page.getByRole('region', { name: 'Codex renamed-review', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'renamed-review · Codex', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(fixture.calls.filter((call) => call.op === 'rename-profile')).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'renamed-review · Codex', exact: true })).toBeVisible()
})

test('visible login rename keeps assignments and account details under the new name', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.profiles[0].active_runs = 0
  fixture.catalog.auths[0].verification = 'verified'
  fixture.catalog.auths.push({ provider: 'codex', auth: 'personal', profiles: [] })
  await page.goto('/#/agents/profiles')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await (await loginAction(page, 'Rename login')).click()
  const form = page.getByRole('region', { name: 'Rename saved login', exact: true })
  await form.getByRole('textbox', { name: 'Login name', exact: true }).fill('personal')
  await expect(form.getByRole('button', { name: 'Save name', exact: true })).toBeDisabled()
  await form.getByRole('textbox', { name: 'Login name', exact: true }).fill('business')
  await form.getByRole('button', { name: 'Save name', exact: true }).click()
  await expect(page.getByRole('region', { name: 'business', exact: true }).getByRole('button', { name: 'Account access verified', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'business', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(fixture.catalog.profiles[0].auth).toBe('business')
  expect(fixture.calls.filter((call) => call.op === 'rename-login')).toHaveLength(1)
  await page.reload()
  await section(page, 'Saved logins')
  await expect(page.getByRole('button', { name: 'business', exact: true })).toBeVisible()
})

test('rename explains protected native profiles and running homes', async ({ page }) => {
  await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'default · Codex', exact: true }).click()
  await expect(await profileAction(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('The native default profile keeps its name.')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await expect(await profileAction(page)).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await expect(await loginAction(page, 'Rename login')).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('Stop agents using this login to rename it.')).toBeVisible()
})

test('rename explains background servers and becomes available after their process exits', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.sessions.runs.push({ run_id: 'background-server', provider: 'codex', profile: 'work', auth: 'company',
    session_id: 'background-terminal', status: 'running', cwd: '/projects/suite', active: true,
    created_at_millis: Date.now(), error: null, mode: 'app-server',
    observation: { lifecycle: 'running', execution: 'unknown', interaction: 'none', constraint: 'none', health: 'healthy' } })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const rename = await profileAction(page)
  await expect(rename).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText(/A background Codex server is still running/)).toBeVisible()
  fixture.sessions.runs[0].active = false
  fixture.sessions.runs[0].observation!.lifecycle = 'exited'
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Profile library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Refresh agents', exact: true }).click()
  await profileAction(page)
  await expect(rename).not.toHaveAttribute('aria-disabled', 'true')
  await rename.click()
  await expect(page.getByRole('textbox', { name: 'Profile name', exact: true })).toBeEditable()
})

test('rename shows its connection requirement beside a disconnected profile', async ({ page }) => {
  await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  await expect(await profileAction(page)).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Agent Manager connection', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.keyboard.press('Escape')
  const rename = await profileAction(page)
  await expect(rename).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByText('Reconnect to Agent Manager to rename this profile.')).toBeVisible()
})

test('inline rename remains accessible on mobile and cancelling restores focus', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.profiles[0].active_runs = 0
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  await (await profileAction(page)).click()
  await expect(page.getByRole('textbox', { name: 'Profile name', exact: true })).toBeFocused()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Actions for review', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Back to profiles', exact: true }).click()
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await (await loginAction(page, 'Rename login')).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Saved login actions', exact: true })).toBeFocused()
  await (await loginAction(page, 'Rename login')).click()
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})


for (const provider of ['claude', 'antigravity'] as const) {
  test(`${provider} provider setup includes chat support installation`, async ({ page }) => {
    const fixture = await operationalAgents(page)
    const name = provider === 'claude' ? 'Claude Code' : 'Antigravity'
    fixture.catalog.capabilities.push({ provider, installed: true, budgets: false, savedModels: true, authMode: 'native', savedAuth: false })
    fixture.providers.push({ ...fixture.providers[0], provider, activeProfiles: [], sdkInstallations: [{
      backend: `${provider}-sdk`, label: `${name} SDK`, package: provider === 'claude' ? 'claude-agent-sdk' : 'google-antigravity',
      requiredVersion: provider === 'claude' ? '0.2.168' : '0.1.22', version: null, available: false, installer: null, error: null,
    }] })
    await page.goto(`/#/agents/providers?provider=${provider}`)
    const setup = page.getByRole('region', { name: `${name} setup`, exact: true })
    const sdk = setup.getByRole('region', { name: `${name} chat support`, exact: true })
    await sdk.getByRole('button', { name: 'Install chat support', exact: true }).click()
    await expect(sdk.getByRole('progressbar')).toBeVisible()
    expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args))
      .toEqual([expect.objectContaining({ provider, kind: 'install-sdk', whenIdle: true })])
    fixture.complete(fixture.jobs[0])
    await expect(setup.getByRole('region', { name: `${name} account`, exact: true })).toBeVisible()
    await expect(setup).toContainText('Chat support: Installed')
    expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(0)
  })
}

test('provider setup resumes installation and carries a saved login into a new profile', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.auths.push({ provider: 'opencode', auth: 'work-account', profiles: [], verification: 'verified' })
  await page.goto('/#/agents/providers?provider=opencode')
  const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
  await setup.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  await expect(setup.getByRole('progressbar')).toBeVisible()
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'opencode', kind: 'install', method: 'npm', whenIdle: true })
  await page.reload()
  await expect(setup.getByRole('progressbar')).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  fixture.complete(fixture.jobs[0])
  const profile = setup.getByRole('region', { name: 'OpenCode profile', exact: true })
  await expect(profile).toContainText('work-account')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  await profile.getByRole('textbox', { name: 'Profile name', exact: true }).fill('review-agent')
  await page.reload()
  await expect(profile.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('review-agent')
  await profile.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(setup).toContainText('OpenCode is ready')
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(1)
  expect(fixture.calls.find(call => call.op === 'create-profile')?.args).toMatchObject({ provider: 'opencode', auth: 'work-account', profile: 'review-agent' })
  await page.screenshot({ path: test.info().outputPath('provider-ready.png') })
  await setup.getByRole('button', { name: 'Open profile', exact: true }).click()
  await expect(page).toHaveURL(/profile=opencode%2Freview-agent/)
  await expect(page.getByRole('heading', { name: 'review-agent', exact: true })).toBeVisible()
})

test('provider manual installation shares onboarding commands and verifies before account setup', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/providers?provider=opencode')
  const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
  await setup.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install manually', exact: true }).click()
  const manual = setup.getByRole('region', { name: 'Manual installation steps', exact: true })
  await expect(manual).toContainText('npm install -g opencode')
  await expect(manual.getByRole('button', { name: 'Copy installation command', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  Object.assign(fixture.providers[1], { installed: true, usable: true, version: '2.0.0', error: null })
  fixture.catalog.capabilities[1].installed = true
  await manual.getByRole('button', { name: 'Check installation', exact: true }).click()
  await expect(setup.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('provider sign-in can finish elsewhere and continues into its profile without another sign-in', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.capabilities[0].defaultLoginMethod = 'device'
  await page.goto('/#/agents/providers?provider=codex')
  const setup = page.getByRole('region', { name: 'Codex setup', exact: true })
  await setup.getByText('New account', { exact: true }).click()
  await setup.getByRole('button', { name: 'Sign in to Codex', exact: true }).click()
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'codex', kind: 'new-login', auth: 'personal', device: true, structured: true })
  await section(page, 'Saved logins')
  fixture.complete(fixture.jobs[0])
  await expect(page.getByRole('button', { name: 'personal', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/agents\/logins/)
  await section(page, 'Providers')
  const profile = setup.getByRole('region', { name: 'Codex profile', exact: true })
  await expect(profile).toContainText('personal')
  await expect(profile.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('work-2')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  await profile.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(setup.getByRole('button', { name: 'Start a session', exact: true })).toBeVisible()
  await setup.getByRole('button', { name: 'Start a session', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Open terminal', exact: true })).toBeVisible()
})

test('saved-login details open profile creation with the provider and account selected', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.auths[0].verification = 'verified'
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await (await loginAction(page, 'Create profile using this login')).click()
  const setup = page.getByRole('region', { name: 'Codex setup', exact: true })
  await expect(setup.getByRole('region', { name: 'Codex profile', exact: true })).toContainText('company')
  await setup.getByRole('textbox', { name: 'Profile name', exact: true }).fill('another-profile')
  await setup.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(setup).toContainText('Codex is ready')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  expect(fixture.calls.find(call => call.op === 'create-profile')?.args).toMatchObject({ provider: 'codex', auth: 'company', profile: 'another-profile' })
  await section(page, 'Saved logins')
  await page.getByRole('button', { name: 'company', exact: true }).click()
  await (await loginAction(page, 'Create profile using this login')).click()
  await expect(setup.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('work-2')
  await setup.getByRole('textbox', { name: 'Profile name', exact: true }).fill('second-profile')
  await page.reload()
  await expect(setup.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('second-profile')
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(1)
})

test('native provider setup creates one profile before sign-in and retains it across reload', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.capabilities.push({ provider: 'antigravity', installed: true, budgets: false, savedModels: true,
    savedAuth: false, authMode: 'native', homeScope: 'shared' })
  fixture.providers.push({ ...fixture.providers[0], provider: 'antigravity', activeProfiles: [] })
  await page.goto('/#/agents/providers?provider=antigravity')
  const setup = page.getByRole('region', { name: 'Antigravity setup', exact: true })
  await expect(setup).toContainText('Signing in applies to all of them.')
  await expect(setup.getByRole('button', { name: /Saved account$/ })).toHaveCount(0)
  await setup.getByRole('textbox', { name: 'Profile name', exact: true }).fill('native-work')
  await setup.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(1)
  expect(fixture.calls.find(call => call.op === 'create-profile')?.args).toMatchObject({ provider: 'antigravity', profile: 'native-work' })
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ provider: 'antigravity', kind: 'profile-login', profile: 'native-work' })
  await page.reload()
  await expect(setup).toContainText('Finish signing in')
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(1)
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  fixture.complete(fixture.jobs[0])
  await setup.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(setup.getByRole('button', { name: 'Open profile', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(1)
  expect(fixture.catalog.auths.some(row => row.provider === 'antigravity')).toBe(false)
})

for (const mode of ['light', 'dark'] as const) for (const width of [390, 1440]) {
  test(`provider setup is accessible in ${mode} mode at ${width}px`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
    await page.setViewportSize({ width, height: 900 })
    const fixture = await operationalAgents(page)
    await page.goto('/#/agents/providers?provider=opencode')
    const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
    await expect(setup.getByRole('button', { name: 'Install OpenCode', exact: true })).toBeVisible()
    expect((await new AxeBuilder({ page }).include('.provider-setup').analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`provider-setup-${mode}-${width}.png`) })
    expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  })
}

async function providerDetails(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click()
  await page.getByText('Software and maintenance', { exact: true }).click()
  for (const title of ['Installation details', 'CLI installation details', 'Claude SDK installation', 'Antigravity SDK installation']) {
    const disclosure = page.getByRole('button', { name: title, exact: true })
    if (await disclosure.isVisible() && await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
  }
}

test('new profile follows provider installation and account setup and retains its name across reload', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/profiles')
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  const form = page.getByRole('region', { name: 'New agent profile', exact: true })
  await form.getByRole('button', { name: /Provider$/ }).click()
  await page.getByRole('option', { name: /^OpenCode/ }).click()
  await form.getByRole('button', { name: 'Continue', exact: true }).click()
  const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
  await setup.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(1)
  fixture.complete(fixture.jobs[0])
  await setup.getByRole('button', { name: 'Sign in to OpenCode', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(2)
  fixture.complete(fixture.jobs[0])
  await setup.getByRole('textbox', { name: 'Profile name', exact: true }).fill('project-reviewer')
  await page.reload()
  await expect(setup.getByRole('textbox', { name: 'Profile name', exact: true })).toHaveValue('project-reviewer')
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(0)
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(2)
})

test('native provider setup can continue an existing profile without creating another one', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.capabilities.push({ provider: 'antigravity', installed: true, budgets: false, savedModels: true, savedAuth: false, authMode: 'native' })
  fixture.catalog.profiles.push({ id: 'antigravity/unfinished', provider: 'antigravity', profile: 'unfinished', auth: null, active_runs: 0, readiness: { ready: false } })
  fixture.providers.push({ ...fixture.providers[0], provider: 'antigravity', activeProfiles: [] })
  await page.goto('/#/agents/providers?provider=antigravity')
  const setup = page.getByRole('region', { name: 'Antigravity setup', exact: true })
  await setup.getByRole('button', { name: /Use an existing profile$/ }).click()
  await page.getByRole('option', { name: 'unfinished', exact: true }).click()
  await setup.getByRole('button', { name: 'Sign in to profile', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(1)
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toHaveLength(0)
  expect(fixture.jobs[0].profile).toBe('unfinished')
  fixture.complete(fixture.jobs[0])
  await setup.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(setup.getByRole('button', { name: 'Open profile', exact: true })).toBeVisible()
  expect(fixture.catalog.profiles.filter(row => row.provider === 'antigravity')).toHaveLength(1)
})

test('failed provider installation retries the chosen method before continuing to an account', async ({ page }) => {
  const fixture = await operationalAgents(page)
  await page.goto('/#/agents/providers?provider=opencode')
  const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
  await setup.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(1)
  Object.assign(fixture.jobs[0], { status: 'failed', message: 'Installer could not finish.', updatedAt: Date.now() })
  fixture.emit({ type: 'agent-operation-updated', operation: fixture.jobs[0] })
  await expect(setup).toContainText('Installer could not finish.')
  await expect(setup.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toHaveCount(0)
  await setup.getByRole('button', { name: 'Retry operation', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(2)
  expect(fixture.jobs[0].method).toBe('npm')
  fixture.complete(fixture.jobs[0])
  await expect(setup.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start' && call.args.kind === 'new-login')).toHaveLength(0)
})

for (const hasExisting of [false, true]) test(`terminal command repair respects existing commands: ${hasExisting}`, async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.providers[0].terminalCommand = { command: 'codex', alias: 'aixand-codex', ready: false, registered: false,
    directory: '/shared/providers/bin', path: null, defaultPath: null, usingExisting: false, restartTerminal: true,
    policy: 'keep', error: 'Terminal command setup is required.', hasExisting,
    existingPaths: hasExisting ? ['/other/tools/codex'] : [] }
  await page.goto('/#/agents/profiles')
  await section(page, 'Providers')
  await providerDetails(page, 'Codex')
  const terminal = page.getByRole('region', { name: 'codex terminal command', exact: true })
  await expect(terminal).toContainText('CLI installed; terminal command setup needs attention.')
  await terminal.getByRole('button', { name: /Terminal command preference$/ }).click()
  const existing = page.getByRole('option', { name: 'Use currently installed commands', exact: true })
  if (hasExisting) {
    await expect(existing).not.toHaveAttribute('aria-disabled', 'true')
    await existing.click()
  } else {
    await expect(existing).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  }
  await terminal.getByRole('button', { name: 'Set up terminal command', exact: true }).click()
  await expect.poll(() => fixture.calls.filter(call => call.op === 'agent-operation-start').length).toBe(1)
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({
    provider: 'codex', kind: 'setup-command', whenIdle: true, terminalPolicy: hasExisting ? 'keep' : 'prefer',
  })
  expect(fixture.catalog.auths[0].auth).toBe('company')
  expect(fixture.catalog.profiles[0].auth).toBe('company')
})

test('operation search filters grouped activity and keeps selected details readable', async ({ page }) => {
  const fixture = await operationalAgents(page)
  const job = { provider: 'codex', kind: 'check-login', message: 'Account check completed.', createdAt: Date.now(), updatedAt: Date.now(), cancellable: false } as const
  fixture.jobs.push({ ...job, id: 'company-check', auth: 'company', status: 'failed' }, { ...job, id: 'personal-check', auth: 'personal', status: 'succeeded' })
  await page.goto('/#/agents/operations')
  await expect(page.locator('.carrier-message-row')).toHaveCount(2)
  await page.getByRole('searchbox', { name: 'Search operations', exact: true }).fill('personal')
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await page.locator('.carrier-message-row').click()
  await expect(page.locator('.agent-operation-details')).toContainText('personal')
  await page.getByRole('searchbox', { name: 'Search operations', exact: true }).fill('no matching activity')
  await expect(page.getByRole('heading', { name: 'No matching operations', exact: true })).toBeVisible()
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
})

test('saved logins filter by provider and explain an empty search', async ({ page }) => {
  const fixture = await operationalAgents(page)
  fixture.catalog.auths.push({ provider: 'opencode', auth: 'personal', profiles: [] })
  await page.goto('/#/agents/logins')
  await page.getByRole('button', { name: /Filter saved logins by provider$/ }).click()
  await page.getByRole('option', { name: 'OpenCode', exact: true }).click()
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  await expect(page.locator('.carrier-message-row')).toContainText('personal')
  await page.getByRole('searchbox', { name: 'Search saved logins', exact: true }).fill('no matching login')
  await expect(page.getByRole('heading', { name: 'No matching logins', exact: true })).toBeVisible()
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
})

for (const compatible of [true, false]) test(`provider release policy keeps restoration explicit: compatible=${compatible}`, async ({ page }) => {
  const fixture = await operationalAgents(page)
  const version = compatible ? '2.3.1' : '3.0.0'
  const compatibility: NonNullable<ProviderInfo['compatibility']> = {
    status: compatible ? 'compatible' : 'incompatible', compatible, tested: false,
    installedVersion: version, recommendedVersion: '2.2.0', supportedRange: '>=2.0.18,<3.0.0',
    testedVersions: ['2.0.18', '2.1.4', '2.2.0'], policyRevision: 'sha256:test-release-policy',
    reason: compatible ? null : 'OpenCode 3.0.0 is outside the supported range >=2.0.18,<3.0.0. Aixand recommends 2.2.0.',
  }
  Object.assign(fixture.providers[1], { installed: true, usable: true, method: 'npm', version,
    error: null, recommendedVersion: '2.2.0', compatibility, chatCompatibility: compatibility })
  fixture.catalog.capabilities[1].installed = true
  await page.goto('/#/agents/providers?provider=opencode')
  const setup = page.getByRole('region', { name: 'OpenCode setup', exact: true })
  const install = setup.locator('[data-section="install"]')
  await expect(install.locator('h3 button')).toHaveAttribute('aria-expanded', compatible ? 'false' : 'true')
  if (compatible) await install.locator('h3 button').click()
  await expect(install).toContainText('Aixand installs version 2.2.0.')
  await expect(install).toContainText(compatible ? 'Your installed version 2.3.1 is compatible' : 'outside the supported range')
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
  await install.getByRole('button', { name: 'Restore tested version 2.2.0', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(1)
  const start = fixture.calls.find(row => row.op === 'agent-operation-start')!
  expect(start.args).toMatchObject({ provider: 'opencode', kind: 'repair', versionTarget: 'recommended', whenIdle: true })
  Object.assign(fixture.jobs[0], { status: 'failed', message: 'Download interrupted.' })
  fixture.emit({ type: 'agent-operation-updated', operation: fixture.jobs[0] })
  await install.getByRole('button', { name: 'Retry operation', exact: true }).click()
  await expect.poll(() => fixture.jobs.length).toBe(2)
  expect(fixture.calls.filter(row => row.op === 'agent-operation-start')[1].args).toMatchObject({ kind: 'repair', versionTarget: 'recommended' })
  expect(fixture.calls.some(row => ['switch-auth', 'remove-login', 'create-profile'].includes(row.op))).toBe(false)
})
