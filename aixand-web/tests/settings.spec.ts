import { expect, mockAuthentication, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ApprovalSettings, SpawnSettings } from '../src/agents/permissions'
import { agentsRequestSchema } from '../../aixand-server/src/agents/protocol'
import type { Page } from './fixtures'
import { initialSetup, previewCatalog, previewEnvironment, previewProviders } from '../src/auth/agentSetup'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  let progress = initialSetup()
  await page.route('**/api/auth/onboarding/start', route => route.fulfill({ json: progress }))
  await page.route('**/api/auth/onboarding/reconcile', route => route.fulfill({ json: progress }))
  await page.route('**/api/auth/onboarding', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON()
      progress = { ...input.progress, revision: progress.revision + 1 }
    }
    await route.fulfill({ json: progress })
  })
})

for (const theme of ['light', 'dark']) {
test(`settings sections retain entries, support browser navigation, and protect reset actions in ${theme}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
  const { writes } = await resetFixture(page, false, 'agents')
  const navigation = page.getByRole('navigation', { name: 'Settings sections', exact: true })
  await expect(page.getByRole('button', { name: 'Reset everything', exact: true })).toBeHidden()
  await navigation.getByRole('button', { name: 'Devices', exact: true }).click()
  await page.getByRole('textbox', { name: 'NetBird API token', exact: true }).fill('unfinished-test-token')
  await page.screenshot({ path: test.info().outputPath(`settings-devices-${theme}.png`) })
  await navigation.getByRole('button', { name: 'Agent behavior', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/settings\?section=devices$/)
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveValue('unfinished-test-token')
  await page.reload()
  await expect(navigation.getByRole('button', { name: 'Devices', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveValue('')
  await navigation.getByRole('button', { name: 'Data management', exact: true }).click()
  await page.getByRole('button', { name: 'Reset everything', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(writes).toEqual([])
  await page.setViewportSize({ width: 320, height: 900 })
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})
}

async function resetFixture(page: Page, failFirst = false, section = 'data', onReset?: () => void) {
  const writes: { scope: string; key: string; confirmation: string }[] = []
  let broadcast: (event: object) => void = () => {}
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    broadcast = (event) => route.send(JSON.stringify(event))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'workspace-reset') {
        expect(agentsRequestSchema.safeParse(message).success).toBe(true)
        writes.push(message.args)
        if (failFirst && writes.length === 1) {
          route.send(JSON.stringify({ type: 'error', id: message.id, code: 'manager', message: 'Stop active chats before resetting.' }))
          return
        }
        onReset?.()
        broadcast({ type: 'workspace-reset', scope: message.args.scope, key: message.args.key })
      }
      const result = message.op === 'workspace-reset' ? { scope: message.args.scope, chats: 2, projects: 1 }
        : message.op === 'catalog' ? onReset ? previewCatalog() : { profiles: [], auths: [], capabilities: [], cwd: '/workspace' }
          : message.op === 'providers' ? { environment: previewEnvironment('windows'), providers: previewProviders(previewEnvironment('windows')) }
          : message.op === 'spawn-settings-get' ? { defaultMode: 'read-only', revision: 0 }
            : message.op === 'approval-settings-get' ? { autoApprove: false, revision: 0 }
              : message.op === 'connect-devices' ? { configured: false, devices: [] }
                : message.op === 'agent-operations' ? { operations: [] }
                  : message.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : []
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto(`/#/settings?section=${section}`)
  if (section === 'data') await expect(page.getByRole('button', { name: 'Reset chats only', exact: true })).toBeEnabled()
  else await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  return { writes, broadcast: (event: object) => broadcast(event) }
}

test('reset confirmation is accessible, requires the exact phrase, and can be cancelled', async ({ page }) => {
  const { writes } = await resetFixture(page)
  await page.locator('.settings-reset').screenshot({ path: 'artifacts/settings-reset/desktop.png' })
  await page.setViewportSize({ width: 320, height: 844 })
  await page.getByRole('button', { name: 'Reset everything', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset everything?' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Reset everything', exact: true })).toBeDisabled()
  await dialog.getByRole('textbox').fill('RESET CHATS')
  await expect(dialog.getByRole('button', { name: 'Reset everything', exact: true })).toBeDisabled()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'artifacts/settings-reset/mobile-confirmation.png', fullPage: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([])
})

test('chat-only reset clears chat preferences and preserves workflows, projects, and other settings', async ({ page }) => {
  const { writes } = await resetFixture(page)
  await page.evaluate(() => {
    localStorage.setItem('aixand.chat.sidebar', 'collapsed')
    localStorage.setItem('intessio.command.expandedParents', '["chat"]')
    localStorage.setItem('aixand.workflow.library.v1', 'keep-workflows')
    localStorage.setItem('aixand.appearance', 'dark')
    localStorage.setItem('aixand.home.visits.v1', JSON.stringify({ 'chat:deleted': 1, 'terminal:keep': 2 }))
    sessionStorage.setItem('aixand.recovery.deleted.open', 'retry-key')
  })
  await page.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset chats only?' })
  await dialog.getByRole('textbox').fill('RESET CHATS')
  await dialog.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Chats reset successfully.' })).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(writes[0].scope).toBe('chats')
  expect(await page.evaluate(() => ({ sidebar: localStorage.getItem('aixand.chat.sidebar'),
    legacy: localStorage.getItem('intessio.command.expandedParents'), workflows: localStorage.getItem('aixand.workflow.library.v1'),
    appearance: localStorage.getItem('aixand.appearance'), visits: localStorage.getItem('aixand.home.visits.v1'),
    recovery: sessionStorage.getItem('aixand.recovery.deleted.open') }))).toEqual({ sidebar: null, legacy: null,
    workflows: 'keep-workflows', appearance: 'dark', visits: '{"terminal:keep":2}', recovery: null })
})

test('full reset clears current and legacy app storage while preserving unrelated data and authentication', async ({ page }) => {
  const { writes } = await resetFixture(page)
  await page.evaluate(() => {
    localStorage.setItem('aixand.appearance', 'dark')
    localStorage.setItem('intessio.appearance', 'dark')
    localStorage.setItem('aixand.workflow.test-draft', 'remove')
    localStorage.setItem('another-app.preference', 'keep')
    sessionStorage.setItem('aixand.recovery.chat.open', 'remove')
    sessionStorage.setItem('another-app.session', 'keep')
  })
  await page.getByRole('button', { name: 'Reset everything', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset everything?' })
  await dialog.getByRole('textbox').fill('RESET EVERYTHING')
  await dialog.getByRole('button', { name: 'Reset everything', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(writes).toHaveLength(1)
  expect(writes[0].scope).toBe('everything')
  expect(await page.evaluate(() => ({ theme: localStorage.getItem('aixand.appearance'), legacy: localStorage.getItem('intessio.appearance'),
    draft: localStorage.getItem('aixand.workflow.test-draft'), other: localStorage.getItem('another-app.preference'),
    session: sessionStorage.getItem('another-app.session'), recovery: sessionStorage.getItem('aixand.recovery.chat.open') })))
    .toEqual({ theme: null, legacy: null, draft: null, other: 'keep', session: 'keep', recovery: null })
  await expect(page).toHaveURL(/#\/home$/)
})

for (const pendingFlag of [true, false]) {
test(`full reset opens agent onboarding with session pending=${pendingFlag} while the Codex CLI remains installed`, async ({ page }) => {
  let reset = false
  let progress = initialSetup()
  const starts: unknown[] = []
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated: true,
    csrfToken: 'reset-csrf', expiresAt: Date.now() + 3600000, onboardingPending: pendingFlag && reset,
    onboardingStep: pendingFlag && reset ? 'providers' : undefined } }))
  await page.route('**/api/auth/onboarding/start', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('reset-csrf')
    starts.push(route.request().postDataJSON())
    await route.fulfill({ json: progress })
  })
  await page.route('**/api/auth/onboarding/reconcile', route => route.fulfill({ json: progress }))
  await page.route('**/api/auth/onboarding', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON()
      progress = { ...input.progress, revision: progress.revision + 1 }
    }
    await route.fulfill({ json: progress })
  })
  await resetFixture(page, false, 'data', () => { reset = true })
  await page.getByRole('button', { name: 'Reset everything', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset everything?' })
  await expect(dialog).toContainText('managed agent profiles, saved accounts, API keys, and agent setup progress')
  await dialog.getByRole('textbox').fill('RESET EVERYTHING')
  await dialog.getByRole('button', { name: 'Reset everything', exact: true }).click()
  await expect(page).toHaveURL(/#\/home$/)
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(starts).toEqual([{ manual: true }])
  expect(await page.evaluate(() => window.history.state?.aixandResetOnboarding)).toBeUndefined()
  await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Continue(?: with \d+ agents?)?$/ }).click()
  await expect(page.getByRole('button', { name: 'Sign in to Codex', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install Codex', exact: true })).toHaveCount(0)
  expect(progress.drafts.codex?.done ?? false).toBe(false)
})
}

test('an interrupted onboarding handoff retries without resetting workspace data again', async ({ page }) => {
  let starts = 0
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/auth/onboarding/start', async route => {
    starts++
    await route.fulfill(starts === 1
      ? { status: 503, json: { message: 'Agent setup is reconnecting.' } }
      : { json: initialSetup() })
  })
  const { writes } = await resetFixture(page)
  await page.getByRole('button', { name: 'Reset everything', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset everything?' })
  await dialog.getByRole('textbox').fill('RESET EVERYTHING')
  await dialog.getByRole('button', { name: 'Reset everything', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Agent setup is reconnecting.')
  expect(await page.evaluate(() => window.history.state?.aixandResetOnboarding)).toBe(true)
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(starts).toBe(2)
  expect(writes).toHaveLength(1)
  expect(await page.evaluate(() => window.history.state?.aixandResetOnboarding)).toBeUndefined()
})

test('failed resets keep data and confirmation visible and reuse the retry key', async ({ page }) => {
  const { writes } = await resetFixture(page, true)
  await page.evaluate(() => localStorage.setItem('aixand.chat.sidebar', 'collapsed'))
  await page.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset chats only?' })
  await dialog.getByRole('textbox').fill('RESET CHATS')
  await dialog.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Stop active chats before resetting.')
  expect(await page.evaluate(() => localStorage.getItem('aixand.chat.sidebar'))).toBe('collapsed')
  await dialog.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Chats reset successfully.' })).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[0]).toEqual(writes[1])
})

test('reset broadcasts clear stale browser state in other tabs', async ({ page }) => {
  const { broadcast, writes } = await resetFixture(page)
  await page.evaluate(() => sessionStorage.setItem('aixand.recovery.old-chat.open', 'remove'))
  broadcast({ type: 'workspace-reset', scope: 'everything', key: crypto.randomUUID() })
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('aixand.recovery.old-chat.open'))).toBeNull()
  expect(writes).toEqual([])
})

test('browser storage failures keep the reset retryable after the server succeeds', async ({ page }) => {
  const { writes } = await resetFixture(page)
  await page.evaluate(() => {
    localStorage.setItem('aixand.chat.sidebar', 'collapsed')
    const remove = Storage.prototype.removeItem
    Storage.prototype.removeItem = function (key: string) {
      if (key === 'aixand.chat.sidebar') throw new DOMException('Storage blocked', 'SecurityError')
      remove.call(this, key)
    }
    window.__restoreResetStorage = () => { Storage.prototype.removeItem = remove }
  })
  await page.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Reset chats only?' })
  await dialog.getByRole('textbox').fill('RESET CHATS')
  await dialog.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Server data was reset, but browser data could not be cleared.')
  await page.evaluate(() => window.__restoreResetStorage())
  await dialog.getByRole('button', { name: 'Reset chats only', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Chats reset successfully.' })).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[0].key).toBe(writes[1].key)
})

test('reset actions are disabled without a server connection', async ({ page }) => {
  await page.routeWebSocket('**/api/agents/ws', () => {})
  await page.goto('/#/settings?section=data')
  await expect(page.getByRole('button', { name: 'Reset chats only', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Reset everything', exact: true })).toBeDisabled()
})

for (const theme of ['light', 'dark']) {
test(`app auto-approval confirms pending saves, restores changes, and remains accurate after failure in ${theme}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
  let settings: ApprovalSettings = { autoApprove: false, revision: 0 }
  let rejectSave = false
  let holdSave = true
  let finishSave: (() => void) | undefined
  let broadcast: () => void
  const writes: object[] = []
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    broadcast = () => route.send(JSON.stringify({ type: 'approval-settings-changed', settings }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'approval-settings-set') {
        expect(agentsRequestSchema.safeParse(message).success).toBe(true)
        writes.push(message.args)
        if (rejectSave) {
          route.send(JSON.stringify({ type: 'error', id: message.id, code: 'manager', message: 'Approval settings changed elsewhere.' }))
          return
        }
        const complete = () => {
          settings = { autoApprove: message.args.autoApprove, revision: settings.revision + 1 }
          broadcast()
          route.send(JSON.stringify({ type: 'result', id: message.id, result: settings }))
        }
        if (holdSave) finishSave = complete
        else complete()
        return
      }
      const result = message.op.startsWith('approval-settings-') ? settings
        : message.op === 'spawn-settings-get' ? { defaultMode: 'read-only', revision: 0 }
          : message.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' }
            : message.op === 'agent-operations' ? { operations: [] }
              : message.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : []
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/settings')
  const toggle = page.getByRole('switch', { name: 'Automatically approve requests', exact: true })
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('status').filter({ hasText: 'Saving approval settings…' })).toBeVisible()
  await expect(page.getByText('Approval settings saved.', { exact: true })).toHaveCount(0)
  holdSave = false
  finishSave!()
  await expect(page.getByText('Approval settings saved.', { exact: true })).toBeVisible()
  expect(writes).toEqual([{ autoApprove: true, expectedRevision: 0 }])
  await page.reload()
  await expect(toggle).toBeChecked()
  settings = { autoApprove: false, revision: 2 }; broadcast!()
  await expect(toggle).not.toBeChecked()
  settings = { autoApprove: true, revision: 3 }; broadcast!()
  await expect(toggle).toBeChecked()
  rejectSave = true
  await toggle.click()
  await expect(page.getByRole('alert')).toContainText('Approval settings changed elsewhere.')
  await expect(toggle).toBeChecked()
  rejectSave = false
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  expect(writes.at(-1)).toEqual({ autoApprove: false, expectedRevision: 3 })
  await page.reload()
  await expect(toggle).not.toBeChecked()
})
}

test('spawn default is saved on the server, restored on reload, and failures remain visible', async ({ page }) => {
  let settings: SpawnSettings = { defaultMode: 'read-only', revision: 0 }
  let rejectSave = false
  let broadcast: () => void
  const writes: object[] = []
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    broadcast = () => route.send(JSON.stringify({ type: 'spawn-settings-changed', settings }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { route.send(JSON.stringify({ type: 'ready' })); return }
      if (message.op === 'spawn-settings-set') {
        writes.push(message.args)
        if (rejectSave) {
          route.send(JSON.stringify({ type: 'error', id: message.id, code: 'manager', message: 'Could not save spawn settings' }))
          return
        }
        settings = { defaultMode: message.args.defaultMode, revision: settings.revision + 1 }
        route.send(JSON.stringify({ type: 'spawn-settings-changed', settings }))
      }
      const result = message.op.startsWith('spawn-settings-') ? settings
        : message.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' }
          : message.op === 'agent-operations' ? { operations: [] }
            : message.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : []
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/settings')
  const selector = page.getByRole('button', { name: /Default access/ })
  await expect(selector).toBeEnabled()
  await selector.click()
  await page.getByRole('option', { name: /Full access \/ YOLO/ }).click()
  await page.getByRole('button', { name: 'Save default access', exact: true }).click()
  await expect(page.getByText('Default access saved.', { exact: true })).toBeVisible()
  expect(writes).toEqual([{ defaultMode: 'full-access', expectedRevision: 0 }])
  await page.reload()
  await expect(selector).toContainText('Full access / YOLO')
  settings = { defaultMode: 'workspace-auto', revision: settings.revision + 1 }
  broadcast!()
  await expect(selector).toContainText('Workspace automatic')
  settings = { defaultMode: 'full-access', revision: settings.revision + 1 }
  broadcast!()
  await expect(selector).toContainText('Full access / YOLO')
  await expect(page.getByRole('button', { name: 'Save default access', exact: true })).toBeDisabled()
  rejectSave = true
  await selector.click()
  await page.getByRole('option', { name: /Workspace automatic/ }).click()
  await page.getByRole('button', { name: 'Save default access', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Could not save spawn settings')
  expect(settings.defaultMode).toBe('full-access')
  await page.reload()
  await expect(selector).toContainText('Full access / YOLO')
  rejectSave = false
  await selector.click()
  await page.getByRole('option', { name: /^Manual/ }).click()
  await page.getByRole('button', { name: 'Save default access', exact: true }).click()
  await expect(page.getByText('Default access saved.', { exact: true })).toBeVisible()
  expect(writes.at(-1)).toEqual({ defaultMode: 'manual', expectedRevision: settings.revision - 1 })
  await page.reload()
  await expect(selector).toContainText('Manual')
})

test('profile menu opens Settings with keyboard support and a remembered debug preference', async ({ page }) => {
  await page.goto('/#/home')
  expect(await page.evaluate(() => window.aixandVoxDiagnostics)).toBeUndefined()
  const profile = page.getByRole('button', { name: 'Profile menu', exact: true })
  await profile.focus(); await page.keyboard.press('Enter')
  const settings = page.getByRole('menuitem', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await settings.focus(); await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused()
  await expect(page).toHaveTitle('Aixand · Settings')
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Troubleshooting', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Debug mode', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect.poll(() => page.evaluate(() => !!window.aixandVoxDiagnostics)).toBe(true)
  await page.reload()
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect.poll(() => page.evaluate(() => !!window.aixandVoxDiagnostics)).toBe(false)
  await page.reload()
  await expect(toggle).not.toBeChecked()
})

test('diagnostics are opt-in, bounded by count and bytes, console capped, and cleared on disable', async ({ page }) => {
  const logs: string[] = []
  page.on('console', (message) => { if (message.text().startsWith('[Vox]')) logs.push(message.text()) })
  await page.goto('/#/settings?section=troubleshooting')
  const disabled = await page.evaluate(async () => {
    const { VoxDiagnostics } = await import('/src/vox/diagnostics.ts')
    const collector = new VoxDiagnostics()
    let evaluated = 0
    collector.log('disabled', () => { evaluated++; return { capture: true } })
    const report = JSON.parse(collector.report(() => { evaluated++; return { capture: true } }))
    return { evaluated, report }
  })
  expect(disabled).toEqual({ evaluated: 0, report: { version: 'vox-diagnostics-v1', debugEnabled: false, events: [] } })
  expect(logs).toEqual([])
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
  const stress = await page.evaluate(async () => {
    const { VoxDiagnostics, DIAGNOSTIC_LIMITS } = await import('/src/vox/diagnostics.ts')
    const collector = new VoxDiagnostics()
    for (let index = 0; index < 500; index++) collector.log(`small-${index}`, { index })
    const small = JSON.parse(collector.report(() => ({})))
    for (let index = 0; index < 1500; index++) collector.log(`large-${index}`, { payload: '🙂'.repeat(4000) })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    collector.log('cycle', cycle)
    const report = collector.report(() => ({ nested: Array(100).fill({ payload: '🙂'.repeat(4000) }) }))
    const large = JSON.parse(report)
    return { limits: DIAGNOSTIC_LIMITS, smallCount: small.events.length, smallLatest: small.events.at(-1).event,
      largeCount: large.events.length, bufferBytes: large.bufferBytes, reportBytes: new TextEncoder().encode(report).byteLength,
      latest: large.events.at(-1), savedExport: !!(window.__savedVoxExport = window.aixandVoxDiagnostics!.export) }
  })
  expect(stress.smallCount).toBe(200)
  expect(stress.smallLatest).toBe('small-499')
  expect(stress.largeCount).toBeLessThanOrEqual(stress.limits.events)
  expect(stress.bufferBytes).toBeLessThanOrEqual(stress.limits.bufferBytes)
  expect(stress.reportBytes).toBeLessThanOrEqual(stress.limits.reportBytes)
  expect(stress.latest.details.self).toBe('[Circular]')
  expect(logs.length).toBeLessThanOrEqual(stress.limits.consoleMessages)
  const count = logs.length
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).uncheck()
  expect(await page.evaluate(() => window.aixandVoxDiagnostics)).toBeUndefined()
  expect(await page.evaluate(() => JSON.parse(window.__savedVoxExport()))).toEqual({ version: 'vox-diagnostics-v1', debugEnabled: false, events: [] })
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
  const fresh = await page.evaluate(() => JSON.parse(window.aixandVoxDiagnostics!.export()))
  expect(fresh.events.every((event: { event: string }) => event.event === 'diagnostics-ready')).toBe(true)
  expect(logs.length).toBe(count)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: () => new Promise((_resolve, reject) => { window.__denyVoxCopy = reject }) } })
  })
  await page.getByRole('button', { name: 'Vox assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Vox assistant' })
  await panel.getByText('Voice diagnostics', { exact: true }).click()
  await panel.getByRole('button', { name: 'Copy diagnostics', exact: true }).click()
  await panel.getByRole('button', { name: 'Hide Vox', exact: true }).click()
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).uncheck()
  await page.evaluate(() => window.__denyVoxCopy(new Error('Clipboard blocked')))
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
  await page.getByRole('button', { name: 'Vox assistant', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Vox diagnostics report', exact: true })).toHaveCount(0)
  await expect(panel.getByText('Copied', { exact: true })).toHaveCount(0)
})

test('debug preference updates across tabs and storage failures are visible', async ({ page, context }) => {
  await page.goto('/#/settings?section=troubleshooting')
  const second = await context.newPage(); await mockAuthentication(second)
  await second.goto('/#/settings?section=troubleshooting')
  await expect(second.getByRole('switch', { name: 'Debug mode', exact: true })).toBeEnabled()
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
  await expect(second.getByRole('switch', { name: 'Debug mode', exact: true })).toBeChecked()
  await second.getByRole('switch', { name: 'Debug mode', exact: true }).uncheck()
  await expect(page.getByRole('switch', { name: 'Debug mode', exact: true })).not.toBeChecked()
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage unavailable', 'QuotaExceededError') } })
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
  await expect(page.getByRole('alert')).toContainText('could not be saved')
  await expect(page.getByRole('switch', { name: 'Debug mode', exact: true })).toBeChecked()
  await page.getByRole('switch', { name: 'Debug mode', exact: true }).uncheck()
  expect(await page.evaluate(() => window.aixandVoxDiagnostics)).toBeUndefined()
})

test('Settings fits mobile and passes accessibility checks in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.addInitScript((mode) => localStorage.setItem('aixand.appearance', mode), theme)
    await page.goto('/#/settings')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 320, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  }
})
