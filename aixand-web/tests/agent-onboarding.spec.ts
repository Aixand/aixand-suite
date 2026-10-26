import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from './fixtures'
import type { AgentJob, Catalog, ProviderInfo } from '../src/agents/client'
import { initialSetup, previewCatalog, previewEnvironment, previewProviders, setupDraft, type SetupState } from '../src/auth/agentSetup'

async function preview(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Onboarding', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('preview password only 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('preview password only 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
}
async function start(page: Page) {
  await page.getByRole('button', { name: /^Continue(?: with \d+ agents?)?$/ }).click()
}
async function choose(page: Page, name: string) {
  if (await page.getByRole('navigation', { name: 'Selected agents' }).isVisible()) {
    await page.getByRole('navigation', { name: 'Selected agents' }).getByRole('button', { name: new RegExp(`^${name} `) }).click()
  } else {
    await page.getByRole('button', { name: /Selected agent$/ }).click()
    await page.getByRole('option', { name: new RegExp(`^${name}`) }).click()
  }
}
async function install(page: Page, name: string, method = 'Install automatically') {
  await page.getByRole('button', { name: `Install ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: method, exact: true }).click()
}
async function signIn(page: Page) {
  await page.getByRole('button', { name: /^Sign in to (Codex|OpenCode|Claude Code)$/ }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
}
async function create(page: Page, name = 'work') {
  await page.getByLabel('Profile name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create profile', exact: true }).click()
}

test('onboarding offers the supported agents without Gemini', async ({ page }) => {
  await preview(page)
  const providers = page.getByRole('region', { name: 'Available agents', exact: true })
  await expect(providers.getByRole('checkbox')).toHaveCount(5)
  await expect(providers.getByRole('checkbox', { name: 'Antigravity', exact: true })).toBeVisible()
  await expect(providers.getByRole('checkbox', { name: /Gemini/ })).toHaveCount(0)
})

for (const { width, height } of [{ width: 1280, height: 720 }, { width: 1024, height: 640 }, { width: 390, height: 780 }]) {
  test(`agent onboarding fills ${width}x${height} without page scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await preview(page)
    const footer = page.locator('.setup-workspace-footer')
    const overlay = page.locator('.onboarding-overlay')
    const assertFits = async () => {
      expect(await overlay.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, viewport: innerHeight })))
        .toEqual({ top: 0, height, viewport: height })
      await expect(footer.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
      const panel = await page.locator('.setup-workspace-layout').boundingBox()
      const actions = await footer.boundingBox()
      expect(panel!.height).toBeGreaterThan(100)
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(actions!.y)
    }
    await assertFits()
    await page.getByRole('region', { name: 'Available agents', exact: true }).hover()
    await page.mouse.wheel(0, 1000)
    await assertFits()
    await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
    await start(page)
    await choose(page, 'OpenCode')
    await assertFits()
    await page.screenshot({ path: `artifacts/onboarding/fullscreen-${width}x${height}-agents.png` })
  })
}

async function realSetup(page: Page, options: {
  environment?: ReturnType<typeof previewEnvironment>
  providers?: ProviderInfo[]
  failFirstInstall?: boolean
  motion?: 'reduce' | 'no-preference'
  savedAccounts?: Catalog['auths']
  savedProfiles?: Catalog['profiles']
  capabilities?: Catalog['capabilities']
  progress?: SetupState
  operations?: AgentJob[]
  runningLogin?: boolean
  loginChallenge?: { verificationUrl: string; userCode?: string; kind?: 'authorization-code' } | null
  failExtraProfile?: boolean
  reconciledProgress?: SetupState
  reconcileFailure?: string
} = {}) {
  const { failFirstInstall = false, motion = 'reduce', savedAccounts = [], savedProfiles = [] } = options
  let saved: SetupState = options.progress ?? initialSetup()
  const environment = options.environment ?? previewEnvironment('macos')
  const providers = options.providers ?? previewProviders(environment)
  const catalog: Catalog = previewCatalog()
  catalog.auths = [...savedAccounts]
  catalog.profiles = [...savedProfiles]
  if (options.capabilities) catalog.capabilities = options.capabilities
  const jobs: AgentJob[] = [...(options.operations ?? [])]
  let loginChallenge = options.loginChallenge
  const calls: { op: string; args: Record<string, string> }[] = []
  const emitters = new Set<(value: object) => void>()
  await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: true, csrfToken: 'setup-csrf', expiresAt: Date.now() + 3600000, onboardingPending: saved.status === 'pending', onboardingStep: saved.step } }))
  let reconciled = options.reconciledProgress, reconcileFailure = options.reconcileFailure
  await page.route('**/api/auth/onboarding/reconcile', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('setup-csrf')
    if (reconcileFailure) { const message = reconcileFailure; reconcileFailure = undefined; await route.fulfill({ status: 503, json: { message } }); return }
    if (reconciled) { saved = { ...reconciled, revision: saved.revision + 1 }; reconciled = undefined }
    await route.fulfill({ json: saved })
  })
  await page.route('**/api/auth/onboarding', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON()
      expect(route.request().headers()['x-csrf-token']).toBe('setup-csrf')
      if (input.expectedRevision !== saved.revision) { await route.fulfill({ status: 409, json: { message: 'Setup changed in another tab.' } }); return }
      saved = { ...input.progress, revision: saved.revision + 1 }
    }
    await route.fulfill({ json: saved })
  })
  await page.route('**/api/auth/onboarding/complete', async route => {
    saved = { ...saved, status: 'complete', step: 'done', revision: saved.revision + 1 }
    await route.fulfill({ json: saved })
  })
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  await page.route('**/api/filesystem/locations', route => route.fulfill({ json: { initial: '/fixture', locations: [{ id: 'home', name: 'Home', path: '/fixture' }] } }))
  await page.route('**/api/filesystem/directories?*', route => route.fulfill({ json: { path: '/fixture', name: 'fixture', parent: '/', breadcrumbs: [{ name: 'fixture', path: '/fixture' }], entries: [], total: 0, nextCursor: null } }))
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  await page.routeWebSocket('**/api/agents/ws', socket => {
    const emit = (value: object) => socket.send(JSON.stringify(value))
    emitters.add(emit)
    socket.onClose(() => emitters.delete(emit))
    emit({ type: 'ready' })
    socket.onMessage(raw => {
      const command = JSON.parse(raw.toString()); calls.push(command)
      const args = command.args ?? {}
      let result: unknown = {}
      if (command.op === 'catalog') result = catalog
      if (command.op === 'providers') result = { environment, providers }
      if (command.op === 'agent-operations') result = { operations: jobs }
      if (command.op === 'agent-login-challenge') result = { available: !!loginChallenge, ...(loginChallenge ? { challenge: loginChallenge } : {}) }
      if (command.op === 'agent-operation-start') {
        const failed = failFirstInstall && args.kind === 'install' && !jobs.some(job => job.kind === 'install')
        const running = options.runningLogin && args.kind !== 'install'
        const job: AgentJob = { id: args.key, provider: args.provider, kind: args.kind, auth: args.auth, profile: args.profile, method: args.method, status: failed ? 'failed' : running ? 'running' : 'succeeded',
          createdAt: Date.now(), updatedAt: Date.now(), cancellable: false, message: failed ? 'Fixture installation failed.' : running ? 'Fixture sign-in waiting.' : 'Fixture operation completed.',
          result: failed || running ? undefined : { verification: 'verified', loginSaved: args.kind !== 'install' } }
        jobs.unshift(job); result = job
        if (args.kind === 'install' && !failed) {
          const provider = providers.find(row => row.provider === args.provider)!
          Object.assign(provider, { installed: true, usable: true, version: '2.0.23', error: null })
        } else if (args.kind !== 'install' && args.auth && !running) {
          const existing = catalog.auths.find(row => row.auth === args.auth && row.provider === args.provider)
          if (existing) Object.assign(existing, { verification: 'verified', checkedAt: Date.now() })
          else catalog.auths.push({ provider: args.provider, auth: args.auth, profiles: [], verification: 'verified', checkedAt: Date.now() })
        }
        emit({ type: 'agent-operation-updated', operation: job }); emit({ type: 'profiles-changed' })
      }
      if (command.op === 'create-profile') {
        if (options.failExtraProfile) { emit({ type: 'error', id: command.id, message: 'Fixture profile could not be created.' }); return }
        catalog.profiles.push({ id: `${args.provider}/${args.profile}`, provider: args.provider, profile: args.profile, auth: args.auth, active_runs: 0 })
      }
      if (command.op === 'project-list') result = []
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (command.op === 'sessions') result = { runs: [] }
      if (['chat-list', 'workflow-list'].includes(command.op)) result = []
      emit({ type: 'result', id: command.id, result })
    })
  })
  await page.emulateMedia({ reducedMotion: motion })
  await page.goto('/#/home')
  return { calls, state: () => saved, catalog, providers, jobs,
    setLoginChallenge: (value: typeof loginChallenge) => { loginChallenge = value },
    notifyProfilesChanged: () => emitters.forEach(emit => emit({ type: 'profiles-changed' })),
    updateOperation: (job: AgentJob) => {
    const index = jobs.findIndex(row => row.id === job.id)
    if (index >= 0) jobs[index] = job
    else jobs.push(job)
    emitters.forEach(emit => emit({ type: 'agent-operation-updated', operation: job }))
  }, finishOperation: (id: string) => {
    const job = jobs.find(row => row.id === id)!
    Object.assign(job, { status: 'succeeded', updatedAt: Date.now(), result: { verification: 'verified', loginSaved: true } })
    if (job.auth) catalog.auths.push({ provider: job.provider, auth: job.auth, profiles: [], verification: 'verified', checkedAt: Date.now() })
    emitters.forEach(emit => { emit({ type: 'agent-operation-updated', operation: job }); emit({ type: 'profiles-changed' }) })
  } }
}

for (const { width, height } of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1440, height: 1000 }]) {
  test(`five agents fit without scrolling at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const providers = previewProviders(previewEnvironment('macos'))
    await realSetup(page, { providers, progress: { ...initialSetup(), selectionInitialized: true, selected: providers.map(row => row.provider) } })
    const available = page.getByRole('region', { name: 'Available agents', exact: true })
    await expect(available.getByRole('checkbox')).toHaveCount(5)
    await expect.poll(() => available.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    for (const row of await available.getByRole('listitem').all()) await expect(row).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `artifacts/onboarding/five-agents-${width}x${height}-picker.png` })
    await start(page)
    const selected = page.getByRole('navigation', { name: 'Selected agents', exact: true }).getByRole('list')
    await expect(selected.getByRole('listitem')).toHaveCount(5)
    expect(await selected.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `artifacts/onboarding/five-agents-${width}x${height}-setup.png` })
  })
}

test('Codex sign-in opens its provider page and lets users copy the code and link without restarting sign-in', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const verificationUrl = 'https://auth.openai.com/codex/device'
  await context.route('https://auth.openai.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture sign-in page</h1>' }))
  const job: AgentJob = { id: '13f77f66-cf40-4628-8641-33642ea726b5', provider: 'codex', kind: 'new-login', auth: 'personal',
    structured: true, status: 'running', phase: 'awaiting-user', createdAt: 1, updatedAt: 1, cancellable: true,
    message: 'Complete sign-in in your browser.' }
  const fixture = await realSetup(page, { operations: [job], loginChallenge: { verificationUrl, userCode: 'TEST-CODE' },
    progress: { ...initialSetup(), selectionInitialized: true, step: 'login', selected: ['codex'], current: 'codex',
      drafts: { codex: { ...setupDraft(), operationId: job.id } } } })
  const challenge = page.getByRole('region', { name: 'Provider sign-in', exact: true })
  await expect(challenge.getByLabel('Device code')).toHaveText('TEST-CODE')
  await challenge.getByRole('button', { name: 'Copy code', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('TEST-CODE')
  await challenge.getByRole('button', { name: 'Copy sign-in link', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(verificationUrl)
  const workspaceUrl = page.url()
  const opened = page.waitForEvent('popup')
  await challenge.getByRole('link', { name: 'Continue to sign in', exact: true }).click()
  const popup = await opened
  await expect(popup.getByRole('heading', { name: 'Fixture sign-in page' })).toBeVisible()
  expect(popup.url()).toBe(verificationUrl)
  expect(page.url()).toBe(workspaceUrl)
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await popup.close()
})

test('Claude onboarding requires its saved account to be ready even after a successful login command', async ({ page }) => {
  const job: AgentJob = { id: 'e5915270-dac9-4dc3-b2d9-a9576cffbc74', provider: 'claude', kind: 'profile-login', profile: 'work',
    status: 'succeeded', createdAt: 1, updatedAt: 1, cancellable: false,
    message: 'Provider login command completed; account verification is unavailable.', result: { verification: 'unsupported' } }
  const profile: Catalog['profiles'][number] = { id: 'claude/work', provider: 'claude', profile: 'work', auth: null, active_runs: 0,
    readiness: { ready: false, verification: 'unsupported', reason: 'Complete official sign-in.' } }
  const fixture = await realSetup(page, { operations: [job], savedProfiles: [profile],
    capabilities: previewCatalog().capabilities.map(row => row.provider === 'claude' ? { ...row, authMode: 'native', savedAuth: false } : row),
    providers: previewProviders(previewEnvironment('macos')).map(row => row.provider === 'claude' ? { ...row, installed: true, usable: true, error: null } : row),
    progress: { ...initialSetup(), selectionInitialized: true, step: 'login', selected: ['claude'], current: 'claude',
      drafts: { claude: { ...setupDraft(), profileName: 'work', nativeProfile: 'work', done: true, operationId: job.id } } } })
  await expect(page.getByRole('button', { name: 'Sign in to profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  fixture.catalog.profiles[0].readiness = { ready: true, verification: 'unsupported', reason: null }
  fixture.notifyProfilesChanged()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('Antigravity waits for workspace questions, then finishes from the verified receipt without a manual exit', async ({ page }) => {
  const job: AgentJob = { id: 'ad4c2f9c-468e-4e69-b24c-8232b4674d2e', provider: 'antigravity', kind: 'profile-login', profile: 'work',
    status: 'running', phase: 'awaiting-user', sessionId: 'sign-in-terminal', createdAt: 1, updatedAt: 1, cancellable: true,
    message: 'Answer the workspace trust question in the terminal. Setup will finish automatically afterward.' }
  const fixture = await realSetup(page, { operations: [job],
    providers: previewProviders(previewEnvironment('windows')).map(row => row.provider === 'antigravity' ? { ...row, installed: true, usable: true, error: null } : row),
    savedProfiles: [{ id: 'antigravity/work', provider: 'antigravity', profile: 'work', auth: null, active_runs: 0 }],
    progress: { ...initialSetup(), selectionInitialized: true, step: 'login', selected: ['antigravity'], current: 'antigravity',
      drafts: { antigravity: { ...setupDraft(), profileName: 'work', nativeProfile: 'work', done: true, operationId: job.id } } } })
  await expect(page.getByText(job.message, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  const previous = fixture.calls.filter(row => row.op === 'agent-operations').length
  await page.getByRole('button', { name: 'Check sign-in', exact: true }).first().click()
  await expect.poll(() => fixture.calls.filter(row => row.op === 'agent-operations').length).toBeGreaterThan(previous)
  expect(fixture.calls.some(row => row.op === 'agent-operation-start')).toBe(false)
  fixture.updateOperation({ ...job, phase: 'verifying', message: 'Checking Antigravity sign-in…', updatedAt: 2 })
  await expect(page.getByText('Checking sign-in', { exact: true }).first()).toBeVisible()
  fixture.updateOperation({ ...job, phase: 'finishing', message: 'Signed in. Finishing setup…', updatedAt: 3 })
  await expect(page.getByText('Finishing sign-in', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check sign-in', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  fixture.updateOperation({ ...job, status: 'succeeded', phase: 'ready', message: 'Signed in. Setup complete.', updatedAt: 4,
    result: { loginSaved: true, credentialPresent: true, verification: 'verified' } })
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

test('installation shows measured download progress, resumes after reload, and stops animation on failure', async ({ page }) => {
  const job: AgentJob = { id: 'fixture-install', provider: 'opencode', kind: 'install', status: 'running',
    createdAt: Date.now(), updatedAt: Date.now(), cancellable: false, message: 'Operation in progress…',
    progress: { schema: 'agent-manager/install-progress-1', stage: 'downloading', label: 'Downloading installer',
      steps: { completed: 1, total: 4 }, transfer: { completed: 256, total: 1024, unit: 'bytes' } } }
  const fixture = await realSetup(page, { progress: { ...initialSetup(), step: 'install', current: 'opencode', selected: ['opencode'],
    selectionInitialized: true, drafts: { opencode: { ...setupDraft(), operationId: job.id } } }, operations: [job] })
  const bar = page.getByRole('progressbar', { name: 'Downloading installer', exact: true })
  await expect(bar).toHaveAttribute('aria-valuenow', '256')
  await expect(bar).toHaveAttribute('aria-valuemax', '1024')
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  await expect(page.getByText('1 of 4 installation steps complete', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install OpenCode', exact: true })).toBeDisabled()
  job.progress!.transfer!.completed = 512
  fixture.updateOperation(job)
  await expect(bar).toHaveAttribute('aria-valuenow', '512')
  await page.reload()
  await expect(bar).toHaveAttribute('aria-valuenow', '512')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toEqual([])
  fixture.updateOperation({ ...job, progress: { ...job.progress!, transfer: { completed: 512, total: null, unit: 'bytes' } } })
  await expect(bar).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByText('512 B downloaded', { exact: true })).toBeVisible()
  const installing: AgentJob = { ...job, progress: { ...job.progress!, stage: 'installing', label: 'Running installer',
    steps: { completed: 2, total: 4 }, transfer: undefined } }
  fixture.updateOperation(installing)
  const activity = page.getByRole('progressbar', { name: 'Running installer', exact: true })
  await expect(activity).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByText('2 of 4 installation steps complete', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(activity).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const accessibility = await new AxeBuilder({ page }).include('.installation-progress').analyze()
  expect(accessibility.violations).toEqual([])
  fixture.updateOperation({ ...installing, status: 'uncertain', message: 'Check the originating terminal.' })
  await expect(activity).toHaveCount(0)
  await expect(page.getByText('Last reported stage: Running installer', { exact: true })).toBeVisible()
  fixture.updateOperation({ ...installing, status: 'failed', message: 'The installer failed.' })
  await expect(page.getByRole('region', { name: 'OpenCode installation', exact: true }).getByRole('progressbar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry operation', exact: true })).toBeVisible()
})

test('existing ready profiles leave only projects and describe the remaining step when closed', async ({ page }) => {
  const existing = readyWorkspace()
  const fixture = await realSetup(page, { ...existing, progress: initialSetup(), reconciledProgress: { ...existing.progress, step: 'projects' } })
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Set up later', exact: true }).click()
  await expect(page.getByText('Your agents are ready. Add your initial projects or skip this step.', { exact: true })).toBeVisible()
  await expect(page.getByText('Finish agent setup to use agent-powered features.', { exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Choose projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => ['create-profile', 'agent-operation-start'].includes(call.op))).toEqual([])
})

test('a configured workspace clears its stale pending wizard after reconciliation', async ({ page }) => {
  const existing = readyWorkspace()
  const fixture = await realSetup(page, { ...existing, progress: initialSetup(), reconciledProgress: { ...existing.progress, status: 'complete', step: 'done' } })
  await expect.poll(() => fixture.state().status).toBe('complete')
  await expect(page.getByRole('dialog', { name: 'Set up your agents', exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue setup', exact: true })).not.toBeVisible()
  expect(fixture.calls.filter(call => ['create-profile', 'agent-operation-start'].includes(call.op))).toEqual([])
})

test('failed Manager reconciliation stays retryable without replacing profiles', async ({ page }) => {
  const existing = readyWorkspace()
  const fixture = await realSetup(page, { ...existing, progress: initialSetup(), reconcileFailure: 'Agent Manager is unavailable.',
    reconciledProgress: { ...existing.progress, step: 'projects' } })
  await expect(page.getByText('Agent Manager is unavailable.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh setup', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => ['create-profile', 'agent-operation-start'].includes(call.op))).toEqual([])
})

test('one workspace completes preview setup without mutating the workspace', async ({ page }) => {
  await preview(page)
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  const cookies = await page.context().cookies()
  const mutations: string[] = []
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(request.url()) })
  await start(page)
  const panel = await page.getByRole('region', { name: 'Codex setup', exact: true }).elementHandle()
  await expect(page.getByRole('button', { name: 'Installation', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await signIn(page)
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('region', { name: 'Codex profile', exact: true })).toBeVisible()
  await create(page, 'my-work')
  await expect(page.getByText('Codex is ready', { exact: true })).toBeVisible()
  expect(await panel!.evaluate(element => element.isConnected)).toBe(true)
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(storage)
  expect(await page.context().cookies()).toEqual(cookies)
  expect(mutations).toEqual([])
})

test('agent search preserves selections and refresh respects deselection', async ({ page }) => {
  await preview(page)
  const search = page.getByRole('searchbox', { name: 'Search agents' })
  await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked()
  await search.fill('open')
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await page.getByRole('button', { name: 'Refresh detection' }).click()
  await expect(search).toHaveValue('open')
  await expect(page.locator('.setup-selection-count')).toHaveText('2 agents selected')
  await search.fill('not an agent')
  await expect(page.getByText('No agents found', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('button', { name: 'Refresh detection' }).click()
  await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).not.toBeChecked()
  await start(page)
  await expect(page.getByRole('region', { name: 'OpenCode setup', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Selected agents' }).getByRole('button', { name: 'Add agents', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'OpenCode', exact: true })).toBeChecked()
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
})

test('Install opens a choice and manual instructions without starting an operation', async ({ page }) => {
  const fixture = await realSetup(page)
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await choose(page, 'OpenCode')
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeDisabled()
  await install(page, 'OpenCode', 'Install manually')
  await expect(page.getByRole('region', { name: 'Manual installation steps' })).toContainText('macOS')
  await expect(page.getByRole('button', { name: 'Copy installation command', exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await install(page, 'OpenCode')
  await expect(page.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Installation', exact: true })).toHaveAttribute('aria-expanded', 'false')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args.kind)).toEqual(['install'])
})

test('Antigravity offers automatic installation and host-specific manual instructions on Windows', async ({ page }) => {
  await preview(page)
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'Antigravity', exact: true }).press('Space')
  await page.getByText('Preview controls', { exact: true }).click()
  await page.getByRole('button', { name: /Preview operating system$/ }).click()
  await page.getByRole('option', { name: 'Windows', exact: true }).click()
  await start(page)
  await page.getByRole('button', { name: 'Install Antigravity', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Install automatically', exact: true })).toBeEnabled()
  await page.getByRole('menuitem', { name: 'Install manually', exact: true }).click()
  const instructions = page.getByRole('region', { name: 'Manual installation steps' })
  await expect(instructions).toContainText('PowerShell')
  await expect(instructions).not.toContainText('curl -fsSL')
  await page.getByRole('button', { name: 'Preview machine · Windows', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Installation target', exact: true })).toContainText('Windows')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Simulate manual installation' }).click()
  await expect(page.getByRole('button', { name: 'Create profile and sign in', exact: true })).toBeVisible()
})

for (const { provider, label, method } of [
  { provider: 'copilot', label: 'GitHub Copilot', method: 'npm' },
  { provider: 'antigravity', label: 'Antigravity', method: 'installer' },
]) {
  test(`${label} offers automatic installation and the correct Windows method`, async ({ page }) => {
    const environment = previewEnvironment('windows')
    const fixture = await realSetup(page, { environment, providers: previewProviders(environment) })
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
    await page.getByRole('checkbox', { name: label, exact: true }).press('Space')
    await start(page)
    await install(page, label)
    await expect.poll(() => fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args)).toEqual([
      expect.objectContaining({ provider, kind: 'install', method }),
    ])
    await expect(page.getByRole('button', { name: 'Create profile and sign in', exact: true })).toBeVisible()
  })
}

test('native sign-in creates a profile first and requires an explicit profile selection', async ({ page }) => {
  await preview(page)
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'Antigravity', exact: true }).press('Space')
  await start(page)
  await install(page, 'Antigravity', 'Install manually')
  await page.getByRole('button', { name: 'Simulate manual installation' }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('native-work')
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('native-work')
  await expect(page.getByLabel('Profile name', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await expect(page.getByText('Sign-in is managed by the provider.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByText('Antigravity is ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

test('an unverified saved login requires an explicit profile action', async ({ page }) => {
  await preview(page)
  await start(page)
  await page.getByText('Preview controls', { exact: true }).click()
  await page.getByRole('button', { name: /Preview operation outcome$/ }).click()
  await page.getByRole('option', { name: 'Account verification unavailable', exact: true }).click()
  await signIn(page)
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

test('switching agents preserves pending sign-ins and names, and changing an account invalidates readiness', async ({ page }) => {
  await preview(page)
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await choose(page, 'OpenCode')
  await install(page, 'OpenCode')
  await choose(page, 'Codex')
  await page.getByText('Account name · personal', { exact: true }).click()
  await page.getByLabel('Account name', { exact: true }).fill('codex-personal')
  await page.getByRole('button', { name: 'Sign in to Codex', exact: true }).click()
  await choose(page, 'OpenCode')
  await signIn(page)
  await page.getByLabel('Profile name', { exact: true }).fill('open-work')
  await choose(page, 'Codex')
  await expect(page.getByRole('heading', { name: 'Finish signing in', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
  await create(page, 'codex-work')
  await page.getByRole('button', { name: 'Next agent', exact: true }).click()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('open-work')
  await page.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(page.getByRole('progressbar', { name: '2 of 2 agents ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await choose(page, 'Codex')
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await page.getByRole('button', { name: 'Change first account', exact: true }).click()
  await page.getByRole('button', { name: 'Use another account', exact: true }).click()
  await page.getByRole('radio', { name: 'New account', exact: true }).press('Space')
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await signIn(page)
  await expect(page.getByText('That name is already in use for this provider.', { exact: true })).toBeVisible()
  await create(page, 'codex-new')
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

test('saved accounts are applied explicitly, can be cancelled, and reauthenticate the selected account', async ({ page }) => {
  const fixture = await realSetup(page, { savedAccounts: [
    { provider: 'codex', auth: 'personal', profiles: [], verification: 'verified', checkedAt: 1 },
    { provider: 'codex', auth: 'team', profiles: [], verification: 'unsupported', checkedAt: 1 },
    { provider: 'codex', auth: 'expired', profiles: [], verification: 'failed', checkedAt: 1 },
  ] })
  await start(page)
  await expect(page.getByLabel('Account name', { exact: true })).toHaveValue('personal-2')
  await page.getByRole('radiogroup', { name: 'Account source' }).getByText('Saved accounts', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Use saved account', exact: true }).click()
  const candidate = async (name: string) => {
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('button', { name: 'Use another account', exact: true }).click()
    await page.getByRole('button', { name: /Saved account$/ }).click()
    await page.getByRole('option', { name, exact: true }).click()
  }
  await candidate('team')
  await page.getByRole('button', { name: 'Keep current account', exact: true }).click()
  await expect(page.locator('.setup-account-connected')).toContainText('personal')
  await page.getByRole('button', { name: 'Use another account', exact: true }).click()
  await page.getByRole('button', { name: /Saved account$/ }).click()
  await page.getByRole('option', { name: 'team', exact: true }).click()
  await page.getByRole('button', { name: 'Use saved account', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create profile', exact: true })).toBeVisible()
  await candidate('expired')
  await expect(page.getByRole('alert')).toContainText('could not be verified')
  await page.getByRole('button', { name: 'Sign in again', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create profile', exact: true })).toBeEnabled()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args.kind)).toEqual(['reauthenticate'])
  expect(fixture.calls.findLast(call => call.op === 'agent-operation-start')?.args.auth).toBe('expired')
})

test('local import stays an explicit alternative and keeps its account name', async ({ page }) => {
  const fixture = await realSetup(page)
  await start(page)
  await page.getByText('Account name · personal', { exact: true }).click()
  await page.getByLabel('Account name', { exact: true }).fill('host-work')
  await page.getByText('Other ways to connect', { exact: true }).click()
  await page.getByRole('button', { name: 'Use an account on this machine', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Import local account', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Sign in instead', exact: true }).click()
  await expect(page.getByLabel('Account name', { exact: true })).toHaveValue('host-work')
  await page.getByText('Other ways to connect', { exact: true }).click()
  await page.getByRole('button', { name: 'Use an account on this machine', exact: true }).click()
  await page.getByRole('button', { name: 'Import local account', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Codex profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toContainText('host-work')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args.kind)).toEqual(['import-login'])
})

test('a matching profile can be reused and conflicting or reserved names cannot be submitted', async ({ page }) => {
  const fixture = await realSetup(page, { savedAccounts: [
    { provider: 'codex', auth: 'personal', profiles: ['work'], verification: 'verified', checkedAt: 1 },
  ], savedProfiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
    { id: 'codex/taken', provider: 'codex', profile: 'taken', auth: 'another-account', active_runs: 0 },
  ] })
  await start(page)
  await page.getByRole('radiogroup', { name: 'Account source' }).getByText('Saved accounts', { exact: true }).click()
  await page.getByRole('button', { name: 'Use saved account', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use this profile', exact: true })).toBeEnabled()
  for (const name of ['taken', 'default', 'invalid name', '']) {
    await page.getByLabel('Profile name', { exact: true }).fill(name)
    await expect(page.getByRole('button', { name: 'Create profile', exact: true })).toBeDisabled()
    await page.getByLabel('Profile name', { exact: true }).press('Enter')
    await expect(page.getByRole('region', { name: 'Codex profile', exact: true })).toBeVisible()
  }
  await page.getByLabel('Profile name', { exact: true }).fill('work')
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toEqual([])
})

test('sign-in failure can be retried in place', async ({ page }) => {
  await preview(page)
  await start(page)
  await page.getByText('Preview controls', { exact: true }).click()
  await page.getByRole('button', { name: /Preview operation outcome$/ }).click()
  await page.getByRole('option', { name: 'Failure', exact: true }).click()
  await signIn(page)
  await expect(page.getByRole('alert')).toContainText('Preview operation failed')
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /Preview operation outcome$/ }).click()
  await page.getByRole('option', { name: 'Success', exact: true }).click()
  await signIn(page)
  await expect(page.getByRole('region', { name: 'Codex profile', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('installation retry shows the successful receipt and opens sign-in', async ({ page }) => {
  const fixture = await realSetup(page, { failFirstInstall: true })
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await choose(page, 'OpenCode')
  await install(page, 'OpenCode')
  await expect(page.getByText('Fixture installation failed.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry operation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Installation', exact: true }).click()
  await page.getByText('Installation details', { exact: true }).click()
  await expect(page.getByText('Fixture operation completed.', { exact: true })).toBeVisible()
  await expect(page.getByText('Fixture installation failed.', { exact: true })).toHaveCount(0)
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args.kind)).toEqual(['install', 'install'])
})

test('deferring an agent permits finishing ready agents and including it restores the requirement', async ({ page }) => {
  await preview(page)
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await signIn(page)
  await create(page)
  await page.getByRole('button', { name: 'Next agent', exact: true }).click()
  await page.getByRole('button', { name: 'Set up OpenCode later', exact: true }).click()
  await expect(page.getByRole('progressbar', { name: '1 of 1 agent ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Include OpenCode', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Set up OpenCode later', exact: true }).click()
  await choose(page, 'Codex')
  await page.getByRole('button', { name: 'Set up Codex later', exact: true }).click()
  await expect(page.getByText('Include at least one agent to finish setup.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
})

for (const step of ['install', 'login', 'profile', 'done'] as const) {
  test(`saved ${step} progress resumes in the unified workspace`, async ({ page }) => {
    const connected = step !== 'install'
    const draft = { ...setupDraft(), auth: connected ? 'personal' : '', done: step === 'done' }
    const fixture = await realSetup(page, { progress: { ...initialSetup(), selectionInitialized: true, step, selected: ['codex'], current: 'codex', drafts: { codex: draft } },
      savedAccounts: connected ? [{ provider: 'codex', auth: 'personal', profiles: [], verification: 'verified', checkedAt: 1 }] : [],
      savedProfiles: step === 'done' ? [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 }] : [],
    })
    await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
    if (step === 'install') await expect(page.getByRole('button', { name: 'Sign in to Codex', exact: true })).toBeVisible()
    else if (step === 'done') await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
    else await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('work')
    expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  })
}

for (const kind of ['install', 'reauthenticate'] as const) {
  test(`reloading in-progress ${kind} shows its operation without repeating it`, async ({ page }) => {
    const provider = kind === 'install' ? 'opencode' : 'codex'
    const job: AgentJob = { id: '56d2450b-28cd-4780-b35d-808fcfce12d9', provider, kind, auth: kind === 'reauthenticate' ? 'personal' : undefined,
      status: 'running', createdAt: 1, updatedAt: 1, cancellable: false, message: 'Fixture operation in progress…' }
    const fixture = await realSetup(page, { operations: [job], progress: { ...initialSetup(), selectionInitialized: true, step: 'install', selected: [provider], current: provider,
      drafts: { [provider]: { ...setupDraft(), auth: job.auth ?? '', operationId: job.id } } },
      savedAccounts: job.auth ? [{ provider, auth: job.auth, profiles: [], verification: 'verified', checkedAt: 1 }] : [],
    })
    const message = kind === 'reauthenticate' ? 'Open the terminal to continue signing in.' : 'Fixture operation in progress…'
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    if (kind === 'install') await expect(page.getByRole('button', { name: 'Install OpenCode', exact: true })).toBeDisabled()
    else await expect(page.getByRole('heading', { name: 'Finish signing in', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  })
}

test('live setup saves, resumes, and finishes through the existing manager operations', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const fixture = await realSetup(page)
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
  await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', 'dark')
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'dark')
  expect(await page.evaluate(() => localStorage.getItem('aixand.appearance'))).toBe('dark')
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await install(page, 'OpenCode')
  await page.getByRole('button', { name: 'Sign in to OpenCode', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('saved-work')
  await page.getByRole('button', { name: 'Save and close', exact: true }).click()
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('saved-work')
  await page.reload()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('saved-work')
  await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', 'dark')
  await page.getByRole('button', { name: 'Create profile', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect.poll(() => fixture.state().status).toBe('complete')
  expect(fixture.state().step).toBe('done')
  expect(fixture.catalog.profiles).toContainEqual(expect.objectContaining({ provider: 'opencode', profile: 'saved-work', auth: 'personal' }))
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start').map(call => call.args.kind)).toEqual(['install', 'new-login'])
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const { mode, width } of [
  { mode: 'light', width: 1440 }, { mode: 'dark', width: 1440 },
  { mode: 'light', width: 320 }, { mode: 'dark', width: 390 },
] as const) {
  test(`${mode} unified setup is accessible at ${width}px through installation, account, and profile`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 780 })
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
    await preview(page)
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
    await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
    await start(page)
    for (const phase of ['install', 'account', 'profile', 'ready']) {
      if (phase === 'account') {
        await install(page, 'OpenCode')
        await expect(page.getByRole('button', { name: 'Sign in to OpenCode', exact: true })).toBeVisible()
      }
      if (phase === 'profile') {
        await signIn(page)
        await expect(page.getByLabel('Profile name', { exact: true })).toBeVisible()
      }
      if (phase === 'ready') await create(page, 'my-work')
      await page.locator('.onboarding-overlay').evaluate(element => element.scrollTo(0, 0))
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      expect(await page.locator('.onboarding-overlay').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: `artifacts/onboarding/${mode}-${width}-unified-${phase}.png`, fullPage: true })
    }
    if (width !== 1440) {
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      await page.getByRole('button', { name: 'Profile', exact: true }).click()
      await page.getByRole('button', { name: 'Edit first profile', exact: true }).click()
      expect(await page.locator('.onboarding-overlay').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
      await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
      await page.getByLabel('Profile name', { exact: true }).fill('a-different-name')
      await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
      const nextMode = mode === 'dark' ? 'light' : 'dark'
      await page.getByRole('button', { name: `Switch to ${nextMode} theme`, exact: true }).click()
      await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', nextMode)
      await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('a-different-name')
    }
  })
}

test('first-run workspace remains hidden until the icon finishes moving', async ({ page }) => {
  await realSetup(page, { motion: 'no-preference' })
  const mark = page.locator('[data-layout="setup"] .onboarding-mark')
  await expect(mark).toBeVisible()
  expect(await mark.locator('svg').evaluateAll(pieces =>
    pieces.every(piece => piece.getAnimations().length === 0))).toBe(true)
  await mark.evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!
    animation.pause(); animation.currentTime = 350
  })
  await expect(page.locator('.onboarding-content h1')).toBeHidden()
  await expect(page.locator('.onboarding-fields')).toHaveAttribute('inert', '')
  await mark.evaluate(element => element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!.finish())
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeFocused()
})

function readyWorkspace(): { progress: SetupState; savedAccounts: Catalog['auths']; savedProfiles: Catalog['profiles'] } {
  return {
    progress: { ...initialSetup(), step: 'profile', selectionInitialized: true, selected: ['codex'], current: 'codex',
      drafts: { codex: { ...setupDraft(), auth: 'personal', done: true } } },
    savedAccounts: [{ provider: 'codex', auth: 'personal', profiles: ['work'], verification: 'verified', checkedAt: 1 }],
    savedProfiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 }],
  }
}
async function addExtra(page: Page, name: 'Add account' | 'Add profile') {
  await page.getByRole('button', { name: 'More agent options', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
async function openCollection(page: Page, name: 'Account' | 'Profile' = 'Profile') {
  const toggle = page.getByRole('button', { name, exact: true })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
}

test('setup updates account verification after an external change without a manual refresh', async ({ page }) => {
  const initial = readyWorkspace()
  initial.savedAccounts[0].verification = 'unsupported'
  const fixture = await realSetup(page, initial)
  await openCollection(page, 'Account')
  const accounts = page.getByRole('region', { name: 'Codex account', exact: true })
  await expect(accounts).toContainText('Verification unavailable')
  fixture.catalog.auths[0].verification = 'verified'
  fixture.catalog.auths[0].checkedAt = Date.now()
  fixture.notifyProfilesChanged()
  await expect(accounts.getByText('Verified', { exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
})

test('editing the first profile keeps focus and returning restores its ready state', async ({ page }) => {
  const fixture = await realSetup(page, readyWorkspace())
  await openCollection(page)
  await page.getByRole('button', { name: 'Edit first profile', exact: true }).click()
  const name = page.getByLabel('Profile name', { exact: true })
  await expect(name).toBeFocused()
  await name.press('End')
  await name.pressSequentially('-new')
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('work-new')
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Back to profiles', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Provider profiles' })).toContainText('work')
  await expect(page.getByRole('region', { name: 'Provider profiles' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  expect(fixture.calls.filter(call => call.op === 'create-profile')).toEqual([])
  expect(fixture.catalog.profiles).toHaveLength(1)
})

test('optional preview additions create multiple accounts and profiles while keeping the first profile ready', async ({ page }) => {
  await preview(page)
  await start(page)
  await expect(page.getByRole('button', { name: 'Add profile', exact: true })).toHaveCount(0)
  await signIn(page)
  await create(page)
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  const cookies = await page.context().cookies()
  const mutations: string[] = []
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) mutations.push(request.url()) })
  await openCollection(page)
  await addExtra(page, 'Add profile')
  await expect(page.getByLabel('Profile name')).toHaveValue('work-2')
  await page.getByLabel('Profile name').fill('default')
  await expect(page.getByRole('button', { name: 'Create additional profile', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await page.getByLabel('Profile name').fill('fast')
  await page.getByRole('button', { name: 'Create additional profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Provider profiles' }).getByRole('listitem')).toHaveCount(2)
  await addExtra(page, 'Add account')
  await page.getByLabel('Account name').fill('company')
  await page.getByText('Preview controls', { exact: true }).click()
  await page.getByRole('button', { name: /Preview operation outcome$/ }).click()
  await page.getByRole('option', { name: 'Failure', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in to Codex', exact: true }).click()
  await expect(page.getByRole('progressbar', { name: '1 of 1 agent ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
  await expect(page.getByRole('alert')).toContainText('Preview operation failed')
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: /Preview operation outcome$/ }).click()
  await page.getByRole('option', { name: 'Success', exact: true }).click()
  await signIn(page)
  await expect(page.getByText('Account company added.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add profile for this account', exact: true }).click()
  await expect(page.getByRole('button', { name: /Account for this profile$/ })).toContainText('company')
  await page.getByLabel('Profile name').fill('company-work')
  await page.getByRole('button', { name: 'Create additional profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Provider profiles' }).getByRole('listitem')).toHaveCount(3)
  await openCollection(page, 'Account')
  await expect(page.getByRole('region', { name: 'Provider accounts' }).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toContainText('personal')
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toContainText('work')
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(storage)
  expect(await page.context().cookies()).toEqual(cookies)
  expect(mutations).toEqual([])
})

test('extra sign-in survives closing, switching agents and reload without replacing the first account or repeating the operation', async ({ page }) => {
  const initial = readyWorkspace()
  initial.progress.selected.push('opencode')
  initial.progress.drafts.opencode = { ...setupDraft(), deferred: true }
  const fixture = await realSetup(page, { ...initial, runningLogin: true })
  await openCollection(page)
  await addExtra(page, 'Add account')
  await page.getByLabel('Account name').fill('company')
  await page.getByRole('button', { name: 'Sign in to Codex', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  const key = fixture.state().drafts.codex!.extra!.operationId!
  await page.getByRole('region', { name: 'Additional account' }).getByRole('button', { name: 'Back to accounts', exact: true }).click()
  await choose(page, 'OpenCode')
  await choose(page, 'Codex')
  await page.reload()
  await expect(page.getByText('Codex is ready', { exact: true })).toBeVisible()
  await openCollection(page, 'Account')
  await page.getByRole('button', { name: 'Resume extra setup', exact: true }).click()
  await expect(page.getByText('Finish signing in to company.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  fixture.finishOperation(key)
  await expect(page.getByText('Account company added.', { exact: true })).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  expect(fixture.state().drafts.codex).toMatchObject({ auth: 'personal', profileName: 'work', done: true })
  expect(fixture.catalog.profiles).toEqual(initial.savedProfiles)
})

test('additional profiles use the selected account and persist independently from the first profile', async ({ page }) => {
  const initial = readyWorkspace()
  initial.savedAccounts.push({ provider: 'codex', auth: 'company', profiles: [], verification: 'unsupported', checkedAt: 1 })
  const fixture = await realSetup(page, initial)
  await openCollection(page)
  await addExtra(page, 'Add profile')
  await page.getByRole('button', { name: /Account for this profile$/ }).click()
  await page.getByRole('option', { name: /^company/ }).click()
  await page.getByLabel('Profile name').fill('company-work')
  await page.getByRole('button', { name: 'Save and close', exact: true }).click()
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
  await expect(page.getByLabel('Profile name')).toHaveValue('company-work')
  await page.getByRole('button', { name: 'Create profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Provider profiles' })).toContainText('company-work')
  expect(fixture.catalog.profiles).toContainEqual(expect.objectContaining({ profile: 'company-work', auth: 'company' }))
  expect(fixture.state().drafts.codex).toMatchObject({ auth: 'personal', profileName: 'work', done: true, extra: { mode: null } })
  expect(fixture.calls.filter(call => call.op === 'switch-auth')).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

test('an optional profile failure does not block finishing with the existing profile', async ({ page }) => {
  const fixture = await realSetup(page, { ...readyWorkspace(), failExtraProfile: true })
  await openCollection(page)
  await addExtra(page, 'Add profile')
  await page.getByRole('button', { name: 'Create additional profile', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Fixture profile could not be created.')
  await expect(page.getByText('Codex is ready', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect.poll(() => fixture.state().status).toBe('complete')
  expect(fixture.catalog.profiles).toHaveLength(1)
  expect(fixture.state().drafts.codex).toMatchObject({ auth: 'personal', profileName: 'work', done: true })
})

test('native optional profiles have separate sign-ins and keep the first native profile ready', async ({ page }) => {
  await preview(page)
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'Antigravity', exact: true }).press('Space')
  await start(page)
  await install(page, 'Antigravity', 'Install manually')
  await page.getByRole('button', { name: 'Simulate manual installation' }).click()
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await openCollection(page)
  await expect(page.getByRole('button', { name: 'Add account', exact: true })).toHaveCount(0)
  await addExtra(page, 'Add profile')
  await page.getByLabel('Profile name').fill('second-native')
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
  await expect(page.getByRole('progressbar', { name: '1 of 1 agent ready' })).toBeVisible()
  await page.getByRole('button', { name: 'Complete sign-in (preview)' }).click()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Provider profiles' }).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toContainText('work')
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})

for (const { mode, width } of [
  { mode: 'light', width: 1440 }, { mode: 'dark', width: 1440 },
  { mode: 'light', width: 320 }, { mode: 'dark', width: 390 },
] as const) {
  test(`${mode} optional setup is accessible at ${width}px and keeps finishing available`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 780 })
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
    await realSetup(page, readyWorkspace())
    await openCollection(page)
    await addExtra(page, 'Add profile')
    await page.getByLabel('Profile name').fill('another-workspace')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('region', { name: 'Additional profile' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `artifacts/onboarding/${mode}-${width}-optional-profile.png`, fullPage: true })
    await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('region', { name: 'Additional profile' }).getByRole('button', { name: 'Back to profiles', exact: true }).click()
    await addExtra(page, 'Add account')
    await page.getByLabel('Account name').fill('personal')
    await expect(page.getByText('That name is already in use for this provider.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    if (width !== 1440) await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.locator('.onboarding-overlay').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeInViewport({ ratio: 1 })
  })
}

