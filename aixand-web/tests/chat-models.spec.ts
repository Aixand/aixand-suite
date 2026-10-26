import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Catalog, Profile } from '../src/agents/client'
import type { AgentProfile } from '../src/carrier/client'

type Operation = { id: string; op: string; args: Record<string, unknown> }

async function connect(page: Page, options: { failModels?: boolean; delayReview?: boolean; duplicateProfiles?: boolean;
  catalog?: Partial<Catalog>; carrierProfiles?: AgentProfile[] } = {}) {
  const operations: Operation[] = []
  const errors: string[] = []
  page.on('pageerror', (cause) => errors.push(cause.message))
  let chat: Record<string, unknown> = {}
  const profiles: Profile[] = [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0 },
    { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, model: 'fixture/saved', active_runs: 0 },
  ]
  if (options.duplicateProfiles) profiles.push(profiles[0], {
    id: 'codex/Auto', provider: 'codex', profile: 'Auto', auth: null, active_runs: 0,
  })
  const catalog: Catalog = { profiles, auths: [], capabilities: ['codex', 'opencode'].map(provider => ({
    provider, installed: true, savedModels: true, budgets: false,
  })), cwd: '/workspace', ...options.catalog }
  const service = { connected: true, agent_configured: true, providers: ['codex', 'opencode'], version: 1 }
  let delayedReview: (() => void) | undefined
  await page.routeWebSocket('**/api/carrier/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Operation
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(message)
      const result = message.op === 'agent_profiles' ? options.carrierProfiles ?? (options.duplicateProfiles ? [
        { id: 'legacy-work', provider: 'codex', profile: 'work' },
        { id: 'codex/Auto', provider: 'codex', profile: 'Auto' },
      ] : []) : message.op === 'snapshot' ? { status: service, messages: [], counts: {}, total: 0, next_offset: null } :
        message.op === 'directory' ? { sessions: [], next_after: null } : message.op === 'launch' ? { status: 'active' } : []
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  let refreshCatalog = () => {}
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    refreshCatalog = () => socket.send(JSON.stringify({ type: 'profiles-changed' }))
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Operation
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(message)
      if (message.op === 'models' && options.failModels) {
        socket.send(JSON.stringify({ type: 'error', id: message.id, message: 'Model discovery unavailable' }))
        return
      }
      const result = message.op === 'catalog' ? catalog :
        message.op === 'mcp-catalog' ? { servers: [] } :
        message.op === 'mcp-preview' ? { digest: '', project: null, states: [], selection: {} } :
        message.op === 'models' ? [{ id: message.args.provider === 'codex' ? `${message.args.profile ?? 'work'}-fast` : 'fixture/free',
          name: message.args.provider === 'codex' ? `${message.args.profile ?? 'work'} Fast` : 'OpenCode Free', free: message.args.provider === 'opencode' }] :
        message.op === 'chat-create' ? { id: message.args.key, provider: 'codex', profile: message.args.profile ?? 'work', auth: 'personal',
          model: message.args.model ?? null, cwd: '/workspace', project: '', mode: 'chat', title: 'Hello', status: 'ready',
          createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [] } :
        message.op === 'chat-send' ? { ...chat, status: 'completed', title: message.args.text, updatedAt: 2, revision: 2 } :
        message.op === 'chat-open' ? chat :
        ['chat-list', 'project-list', 'sessions'].includes(message.op) ? [] : {}
      if (message.op === 'chat-create' || message.op === 'chat-send') chat = result as Record<string, unknown>
      const respond = () => socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
      if (message.op === 'models' && message.args.profile === 'review' && options.delayReview) delayedReview = respond
      else respond()
    })
  })
  await page.goto('/#/chat')
  await expect(page.getByLabel('Workspace access key')).toHaveCount(0)
  return { operations, options, errors, catalog, refreshCatalog: () => refreshCatalog(), finishReview: () => delayedReview?.() }
}

async function chooseAgent(page: Page, name: string) {
  await page.getByRole('button', { name: / Provider$/ }).click()
  await page.getByRole('option', { name: name === 'local' ? 'OpenCode' : 'Codex', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click()
}

test('profile selectors merge provider identities and distinguish a saved Auto profile', async ({ page }) => {
  const fixture = await connect(page, { duplicateProfiles: true })
  await expect.poll(() => fixture.operations.some((message) => message.op === 'agent_profiles')).toBe(true)
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option')).toHaveText(['Codex', 'OpenCode'])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option', { name: /^work codex profile/ })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /^Auto Codex/ })).toHaveCount(1)
  await expect(page.getByRole('option', { name: /^Auto \(codex\/Auto\)/ })).toHaveCount(1)
  await page.getByRole('option', { name: /^Auto \(codex\/Auto\)/ }).click()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use the saved profile')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-create')?.args.profile).toBe('Auto')
  expect(fixture.errors).toEqual([])
})

test('providers require a ready profile and an available backend, including SDK-only installations', async ({ page }) => {
  const fixture = await connect(page, { catalog: {
    profiles: [
      { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0, readiness: { ready: false } },
      { id: 'claude/work', provider: 'claude', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
      { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, active_runs: 0, readiness: { ready: false } },
      { id: 'antigravity/work', provider: 'antigravity', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
      { id: 'copilot/work', provider: 'copilot', profile: 'work', auth: null, active_runs: 0, readiness: { ready: true } },
    ],
    capabilities: ['codex', 'claude', 'opencode', 'antigravity', 'copilot'].map(provider => ({
      provider, installed: !['codex', 'antigravity'].includes(provider), savedModels: false, budgets: false,
      ...(provider === 'copilot' ? { label: 'GitHub Copilot' } : {}),
    })),
    backends: [
      { id: 'native-codex', provider: 'codex', label: 'Codex', available: false, controls: {} },
      { id: 'claude-sdk', provider: 'claude', label: 'Claude SDK', available: false, controls: {} },
      { id: 'opencode-acp', provider: 'opencode', label: 'OpenCode', available: true, controls: {} },
      { id: 'antigravity-sdk', provider: 'antigravity', label: 'Antigravity SDK', available: true, controls: {} },
    ],
  }, carrierProfiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work' },
    { id: 'claude/work', provider: 'claude', profile: 'work' },
    { id: 'codex/stale', provider: 'codex', profile: 'stale' },
  ] })
  await expect(page.getByRole('button', { name: 'Antigravity Provider', exact: true })).toBeVisible()
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option')).toHaveText(['Antigravity', 'GitHub Copilot'])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option', { name: 'work (antigravity/work) antigravity profile', exact: true })).toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('unavailable installations and accounts show an empty selector and provider setup', async ({ page }) => {
  const fixture = await connect(page, { catalog: {
    profiles: [
      { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
      { id: 'opencode/local', provider: 'opencode', profile: 'local', auth: null, active_runs: 0, readiness: { ready: false } },
    ],
    capabilities: [
      { provider: 'codex', installed: false, savedModels: false, budgets: false },
      { provider: 'opencode', installed: true, savedModels: false, budgets: false },
    ],
  } })
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'No profiles available Profile', exact: true })).toBeDisabled()
  await expect(page.getByRole('group', { name: 'Agent setup required' })).toContainText('No providers are ready for chat.')
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my draft until setup is ready')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  expect(fixture.operations.some(message => message.op === 'chat-create' || message.op === 'launch')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('catalog updates remove unavailable selections without losing the draft and restore newly ready providers', async ({ page }) => {
  const fixture = await connect(page)
  await chooseAgent(page, 'work')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep these instructions')
  fixture.catalog.profiles[0].readiness = { ready: false }
  fixture.catalog.profiles[1].readiness = { ready: false }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'OpenCode Provider', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Keep these instructions')
  await page.getByRole('button', { name: / Provider$/ }).click()
  await expect(page.getByRole('option')).toHaveText(['OpenCode'])
  await page.keyboard.press('Escape')
  fixture.catalog.profiles[2].readiness = { ready: false }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'No providers available Provider', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  fixture.catalog.profiles[0].readiness = { ready: true }
  await page.getByRole('button', { name: 'Refresh providers', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Codex Provider', exact: true })).toBeVisible()
  await page.getByRole('button', { name: / Profile$/ }).click()
  await expect(page.getByRole('option')).toHaveCount(2)
  await expect(page.getByRole('option', { name: 'Auto Codex · highest available budget · selected at launch', exact: true })).toBeVisible()
  await expect(page.getByRole('option', { name: 'work codex profile', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Keep these instructions')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  expect(fixture.errors).toEqual([])
})

test('model choices follow the profile, preserve instructions, and ignore an older profile response', async ({ page }) => {
  const fixture = await connect(page, { delayReview: true })
  const picker = page.getByRole('button', { name: / Model$/ })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep my instructions')
  await chooseAgent(page, 'work')
  await expect(picker).toBeEnabled()
  await picker.click()
  await page.getByRole('option', { name: /^work Fast/ }).click()
  await page.getByRole('dialog', { name: 'Model settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(picker).toContainText('work Fast')
  await chooseAgent(page, 'review')
  await expect(picker).toContainText('Profile default')
  await expect.poll(() => fixture.operations.filter((message) => message.op === 'models' && message.args.profile === 'review').length).toBe(1)
  await chooseAgent(page, 'local')
  await expect(picker).toBeEnabled()
  fixture.finishReview()
  await picker.click()
  await expect(page.getByRole('option', { name: /^Profile default/ })).toContainText('fixture/saved')
  await expect(page.getByRole('option', { name: /^review Fast/ })).toHaveCount(0)
  await page.getByRole('option', { name: /^OpenCode Free/ }).click()
  await page.getByRole('dialog', { name: 'Model settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(input).toHaveValue('Keep my instructions')
  expect(fixture.operations.filter((message) => message.op === 'models').at(-1)?.args).toEqual({ provider: 'opencode', profile: 'local', cwd: '/workspace' })
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'launch')?.args.model).toBe('fixture/free')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await chooseAgent(page, 'work')
  await expect(picker).toBeEnabled()
  await expect(picker).toContainText('Profile default')
  expect(fixture.errors).toEqual([])
})

test('model discovery errors can be retried and profile default omits the override', async ({ page }) => {
  const fixture = await connect(page, { failModels: true })
  await expect(page.getByText(/Model discovery unavailable/)).toBeVisible()
  expect(fixture.operations.filter(message => message.op === 'models').map(message => message.args)).toEqual([
    { provider: 'codex', profile: null, cwd: '/workspace' },
  ])
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Hello')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeEnabled()
  fixture.options.failModels = false
  await page.getByRole('button', { name: 'Retry model list' }).click()
  const picker = page.getByRole('button', { name: / Model$/ })
  await expect(picker).toBeEnabled()
  expect(fixture.operations.filter(message => message.op === 'models').map(message => message.args.profile)).toEqual([null, null])
  await picker.click()
  await expect(page.getByRole('option', { name: /^work Fast/ })).toBeVisible()
  await page.getByRole('option', { name: /^Profile default/ }).click()
  await page.getByRole('dialog', { name: 'Model settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.filter((message) => message.op === 'chat-create').length).toBe(1)
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('model')
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('cwd')
  expect(fixture.operations.find((message) => message.op === 'chat-create')?.args).not.toHaveProperty('projectId')
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  await expect(picker).toBeDisabled()
  expect(fixture.errors).toEqual([])
})

for (const scenario of [
  { name: 'desktop', theme: 'light', width: 1440, height: 1000 },
  { name: 'mobile', theme: 'dark', width: 390, height: 844 },
]) test(`model tooltip stays anchored until dismissed on ${scenario.name}`, async ({ page }) => {
  await page.addInitScript(theme => localStorage.setItem('aixand.appearance', theme), scenario.theme)
  await page.setViewportSize({ width: scenario.width, height: scenario.height })
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const fixture = await connect(page)
  const picker = page.getByRole('button', { name: 'Profile default Model', exact: true })
  await expect(picker).toBeEnabled()
  await page.mouse.move(200, 300)
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.hover()
    const tooltip = page.getByRole('tooltip', { name: 'Model: Profile default', exact: true })
    await expect(tooltip).toBeVisible()
    const trigger = (await picker.boundingBox())!
    const observation = page.evaluate(async () => {
      const samples: { x: number; y: number; width: number; height: number; placement: string | null; source: string }[] = []
      const record = (source: string) => {
        for (const element of document.querySelectorAll<HTMLElement>('.command-picker-tooltip')) {
          const style = getComputedStyle(element)
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
          const box = element.getBoundingClientRect()
          samples.push({ x: box.x, y: box.y, width: box.width, height: box.height, placement: element.getAttribute('data-placement'), source })
        }
      }
      const observer = new MutationObserver(() => record('mutation'))
      record('initial')
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-placement', 'data-exiting'] })
      await new Promise<void>(resolve => {
        const until = performance.now() + 1000
        const frame = () => {
          record('frame')
          if (performance.now() < until) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      observer.disconnect()
      return samples
    })
    await page.mouse.move(200, 300)
    await expect(tooltip).toHaveCount(0)
    const samples = await observation
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.filter(box => box.x + box.width < trigger.x || box.x > trigger.x + trigger.width ||
      Math.min(Math.abs(box.y + box.height - trigger.y), Math.abs(box.y - trigger.y - trigger.height)) > 24)).toEqual([])
  }
  expect(fixture.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`model picker is accessible on mobile in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    await connect(page)
    const picker = page.getByRole('button', { name: / Model$/ })
    await expect(picker).toBeEnabled()
    await picker.click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/command-models/${theme}-mobile.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(picker).toBeFocused()
    const settings = page.getByRole('button', { name: 'Chat settings', exact: true })
    await settings.click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-composer/${theme}-settings-mobile.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(settings).toBeFocused()
  })
}


test('new chats use the preferred profile and keep it selected when its account needs attention', async ({ page }) => {
  const fixture = await connect(page, { catalog: { profiles: [
    { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0, readiness: { ready: true } },
    { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0,
      preferred: true, readiness: { ready: true, chat: { ready: true } } },
  ] } })
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep the selected account')
  fixture.catalog.profiles[1].readiness = { ready: false, chat: { ready: false, reason: 'Sign-in required' } }
  fixture.refreshCatalog()
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  await expect(page.getByText('Sign-in required', { exact: true })).toBeVisible()
  expect(fixture.operations.some(row => row.op === 'chat-create')).toBe(false)
  fixture.catalog.profiles[1].readiness = { ready: true, chat: { ready: true } }
  fixture.refreshCatalog()
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect.poll(() => fixture.operations.find(row => row.op === 'chat-create')?.args.profile).toBe('review')
  expect(fixture.errors).toEqual([])
})
