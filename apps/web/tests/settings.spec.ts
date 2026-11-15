import { expect, mockAuthentication, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ApprovalSettings, SpawnSettings } from '../src/agents/permissions'
import { agentsRequestSchema } from '../../server/src/agents/protocol'
import type { Page } from './fixtures'
import { initialSetup, previewCatalog, previewEnvironment, previewProviders } from '../src/auth/agentSetup'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/updates', route => route.fulfill({ json: { available: false, message: 'Update feeds are not enabled for this fixture.' } }))
  await page.route('**/api/updates/application', route => route.fulfill({ json: { available: false, message: 'Application updates are managed by the connection window.' } }))
  await page.route('**/api/updates/products', route => route.fulfill({ json: { available: false, message: 'Product update feeds are not enabled for this installation.', inventory: { products: {} } } }))
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

test('individual tool updates review companions, shared ownership and explicit installation consent', async ({ page }) => {
  const requests: Record<string, unknown>[] = []
  let phase = 'available'
  await page.route('**/api/updates', route => route.fulfill({ json: { available: false } }))
  await page.route('**/api/updates/products', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); requests.push(input)
      expect(route.request().headers()['x-csrf-token']).toBe('isolated-ui-csrf')
      if (input.action === 'plan') {
        await route.fulfill({ json: { revision: 'b'.repeat(64), ready: phase === 'downloaded', requested: ['agent-manager'], shared: true,
          candidates: { 'agent-manager': { version: '0.1.1-beta' }, 'prompt-manager': { version: '0.1.1-beta' } },
          blockers: [], unsupported: [], restartRequired: true, licenses: [{ product: 'Agent Manager', text: 'Test license for reviewed tool update', sha256: 'c'.repeat(64) }] } }); return
      }
      if (input.action === 'download') phase = 'downloaded'
    }
    await route.fulfill({ json: { available: true, phase, requested: ['agent-manager', 'runner'], host: { name: 'workspace-server' },
      inventory: { products: { 'agent-manager': { name: 'Agent Manager', version: '0.1.0-beta', scope: 'shared', updatable: true },
        runner: { name: 'Runner', version: '0.1.0-alpha.2', scope: 'private', updatable: true }, 'prompt-manager': { name: 'Prompt Manager', version: '0.1.0-beta', scope: 'shared', updatable: true } } },
      candidates: { 'agent-manager': { version: '0.1.1-beta' }, runner: { version: '0.1.0-alpha.3' } } } })
  })
  await resetFixture(page, false, 'updates')
  await expect(page.getByRole('heading', { name: 'Installed tool updates', exact: true })).toBeVisible()
  await expect(page.getByText('Computer: workspace-server', { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Runner', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Review tool updates', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Review tool updates', exact: true })).toContainText('Prompt Manager: 0.1.1-beta (companion update)')
  await expect(page.getByText('These changes apply to shared tools used by other applications.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install selected tool updates', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Download selected tool updates', exact: true }).click()
  await page.getByRole('button', { name: 'Review tool updates', exact: true }).click()
  await page.getByRole('switch', { name: 'I agree to the displayed tool licenses and companion updates', exact: true }).check()
  await page.getByRole('switch', { name: 'I approve the reviewed tool restart impact', exact: true }).check()
  await page.getByRole('button', { name: 'Install selected tool updates', exact: true }).click()
  expect(requests.find(row => row.action === 'plan')).toEqual({ action: 'plan', products: ['agent-manager'] })
  await expect.poll(() => requests.find(row => row.action === 'install')).toEqual({ action: 'install', confirmed: true, revision: 'b'.repeat(64), acceptedLicenses: ['c'.repeat(64)], restartConsent: true })
})

test('server updates show the host, persist daily checking and require update consent', async ({ page }) => {
  const requests: Record<string, unknown>[] = []
  let daily = true
  await page.route('**/api/updates', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); requests.push(input)
      expect(route.request().headers()['x-csrf-token']).toBe('isolated-ui-csrf')
      if (input.action === 'settings' && input.daily !== undefined) daily = input.daily
      if (input.action === 'plan') { await route.fulfill({ json: { revision: 'a'.repeat(64), ready: true, requested: ['server'], candidates: { server: { version: '0.1.1-beta' }, connect: { version: '0.2.0-beta' } }, blockers: [], unsupported: [], restartRequired: true, licenses: [] } }); return }
    }
    await route.fulfill({ json: { available: true, daily, phase: 'downloaded', mode: 'components', requested: ['server'], inventory: { components: { server: { version: '0.1.0-beta' } } } } })
  })
  await resetFixture(page, false, 'updates')
  await expect(page.getByRole('heading', { name: 'Workspace host updates', exact: true })).toBeVisible()
  await page.getByRole('switch', { name: 'Check for updates daily', exact: true }).uncheck()
  await expect.poll(() => requests.some(row => row.action === 'settings' && row.daily === false)).toBe(true)
  await page.getByRole('button', { name: 'Review update', exact: true }).click()
  const install = page.getByRole('button', { name: 'Install and restart server', exact: true })
  await expect(install).toBeDisabled()
  await page.setViewportSize({ width: 320, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath('updates-review.png'), fullPage: true })
  await page.getByRole('switch', { name: 'I agree to the displayed licenses and companion updates', exact: true }).check()
  await expect(install).toBeDisabled()
  await page.getByRole('switch', { name: 'I approve the reviewed restart impact', exact: true }).check()
  await expect(page.getByText('connect: 0.2.0-beta (companion update)', { exact: true })).toBeVisible()
  await install.click()
  await expect.poll(() => requests.some(row => row.action === 'install' && row.confirmed === true && row.restartConsent === true)).toBe(true)
})

test('whole Server updates use the same page and require their own restart review', async ({ page }) => {
  const requests: object[] = []
  await page.route('**/api/updates/application', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); requests.push(input)
      if (input.action === 'plan') { await route.fulfill({ json: { revision: 'd'.repeat(64), ready: true, requested: ['server'], candidates: { server: { version: '0.1.0-alpha.4' } }, licenses: [], blockers: [], unsupported: [], restartRequired: true } }); return }
    }
    await route.fulfill({ json: { available: true, phase: 'downloaded', updateAvailable: true,
      installed: { role: 'server', version: '0.1.0-alpha.3' }, release: { version: '0.1.0-alpha.4' } } })
  })
  await resetFixture(page, false, 'updates')
  await expect(page.getByRole('table', { name: 'Installed application', exact: true })).toContainText('Server application')
  await page.getByRole('button', { name: 'Review application update', exact: true }).click()
  const install = page.getByRole('button', { name: 'Install application update', exact: true })
  await expect(install).toBeDisabled()
  await page.getByRole('switch', { name: 'I agree to the displayed application licenses and tool changes', exact: true }).check()
  await page.getByRole('switch', { name: 'I approve the application restart impact', exact: true }).check()
  await install.click()
  await expect.poll(() => requests).toContainEqual({ action: 'install', confirmed: true, revision: 'd'.repeat(64), acceptedLicenses: [], restartConsent: true })
})

test('check all sends an authenticated check without installing anything', async ({ page }) => {
  const requests: object[] = []
  await page.route('**/api/updates/check-all', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('isolated-ui-csrf')
    requests.push(route.request().postDataJSON()); await route.fulfill({ json: { started: true } })
  })
  await resetFixture(page, false, 'updates')
  await page.getByRole('button', { name: 'Check all updates', exact: true }).click()
  await expect.poll(() => requests).toEqual([{ action: 'check' }])
})

test('workspace setup opens the real onboarding from Settings and is absent from the profile menu', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  const starts: unknown[] = []
  await page.route('**/api/auth/onboarding/start', async route => {
    starts.push(route.request().postDataJSON())
    await route.fulfill({ json: initialSetup() })
  })
  await resetFixture(page, false, 'agents')
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Settings', 'Recover a chat', 'Sign out'])
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: 'Workspace setup', exact: true }).click()
  await expect(page).toHaveURL(/settings\?section=workspace$/)
  const trigger = page.getByRole('button', { name: 'Set up workspace', exact: true })
  await trigger.click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(starts).toEqual([{ manual: true }])
  await page.getByRole('button', { name: 'Set up later', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(starts).toEqual([{ manual: true }, { manual: true }])
})

test('workspace setup reports a failed start in Settings and can be retried', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.routeWebSocket(/\/api\/(carrier|terminals)\/ws/, () => {})
  let starts = 0
  await page.route('**/api/auth/onboarding/start', async route => {
    starts++
    await route.fulfill(starts === 1
      ? { status: 503, json: { message: 'Workspace setup is reconnecting.' } }
      : { json: initialSetup() })
  })
  await resetFixture(page, false, 'workspace')
  const trigger = page.getByRole('button', { name: 'Set up workspace', exact: true })
  await trigger.click()
  await expect(page.getByRole('alert')).toHaveText('Workspace setup is reconnecting.')
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  expect(starts).toBe(2)
})

for (const theme of ['light', 'dark']) {
test(`settings sections retain entries, support browser navigation, and protect reset actions in ${theme}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
  const { writes } = await resetFixture(page, false, 'agents')
  const navigation = page.getByRole('navigation', { name: 'Settings sections', exact: true })
  await expect(page.getByRole('button', { name: 'Reset everything', exact: true })).toBeHidden()
  await navigation.getByRole('button', { name: 'Devices', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath(`settings-devices-${theme}.png`) })
  await page.getByRole('button', { name: 'Device actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connection settings', exact: true }).click()
  await page.getByRole('textbox', { name: 'NetBird API token', exact: true }).fill('unfinished-test-token')
  await page.getByRole('button', { name: 'Close device setup', exact: true }).click()
  await navigation.getByRole('button', { name: 'Agent behavior', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toBeHidden()
  await page.goBack()
  await expect(page).toHaveURL(/settings\?section=devices$/)
  await page.getByRole('button', { name: 'Device actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connection settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveValue('unfinished-test-token')
  await page.reload()
  await expect(navigation.getByRole('button', { name: 'Devices', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('dialog', { name: 'Connect NetBird', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Device actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connection settings', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'NetBird API token', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Close device setup', exact: true }).click()
  await navigation.getByRole('button', { name: 'Data management', exact: true }).click()
  await expect(page.getByText('Workspace reset from Settings is unavailable in this alpha.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset everything', exact: true })).toHaveCount(0)
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
  if (section === 'data') await expect(page.getByRole('heading', { name: 'Reset data', exact: true })).toBeVisible()
  else await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  return { writes, broadcast: (event: object) => broadcast(event) }
}

test('browser settings retain native-only reset guidance without sending reset operations', async ({ page }) => {
  const { writes } = await resetFixture(page)
  await expect(page.getByText('Workspace reset from Settings is unavailable in this alpha.', { exact: true })).toBeVisible()
  await expect(page.getByText('aixand-server reset', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Reset (chats only|everything)/ })).toHaveCount(0)
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(writes).toEqual([])
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

for (const voice of [false, true]) {
  test(`package voice=${voice} controls Vox and its settings`, async ({ page }) => {
    await page.route('**/api/capabilities', route => route.fulfill({ json: { voice } }))
    let voxConnections = 0
    await page.routeWebSocket(/\/api\/vox\/ws/, () => { voxConnections++ })
    await resetFixture(page, false, 'troubleshooting')
    const trigger = page.getByRole('button', { name: 'Vox assistant', exact: true })
    const section = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Troubleshooting', exact: true })
    if (voice) {
      await expect(trigger).toBeVisible()
      await expect(section).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Debug mode', exact: true })).toBeVisible()
    } else {
      await expect(page.getByRole('heading', { name: 'Agent behavior', exact: true })).toBeVisible()
      await expect(trigger).toHaveCount(0)
      await expect(section).toHaveCount(0)
      await expect(page.getByRole('switch', { name: 'Debug mode', exact: true })).toHaveCount(0)
      expect(voxConnections).toBe(0)
    }
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('menuitem', { name: 'Troubleshooting', exact: true })).toHaveCount(voice ? 1 : 0)
  })
}

test('Vox stays hidden during capability loading and recovers after a failed request', async ({ page }) => {
  let attempts = 0, available = false
  await page.route('**/api/capabilities', async route => {
    attempts++
    await route.fulfill(!available ? { status: 503, json: { message: 'Temporarily unavailable' } } : { json: { voice: true } })
  })
  await resetFixture(page, false, 'agents')
  const trigger = page.getByRole('button', { name: 'Vox assistant', exact: true })
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(1)
  await expect(trigger).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Agent behavior', exact: true })).toBeVisible()
  available = true
  await expect(trigger).toBeVisible({ timeout: 10000 })
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('Codex process isolation persists, synchronizes, and reports save conflicts', async ({ page }) => {
  let settings = { mode: 'separate', revision: 0, sharedSupported: true }
  let rejectSave = false
  let broadcast: () => void = () => {}
  const writes: object[] = []
  await page.routeWebSocket('**/api/agents/ws', route => {
    broadcast = () => route.send(JSON.stringify({ type: 'codex-server-settings-changed', settings }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const message = JSON.parse(String(raw))
      if (message.op === 'codex-server-settings-set') {
        expect(agentsRequestSchema.safeParse(message).success).toBe(true)
        writes.push(message.args)
        if (rejectSave) {
          route.send(JSON.stringify({ type: 'error', id: message.id, code: 'conflict', message: 'Codex server settings changed elsewhere.' }))
          return
        }
        settings = { ...settings, mode: message.args.mode, revision: settings.revision + 1 }
        broadcast()
      }
      const result = message.op.startsWith('codex-server-settings-') ? settings
        : message.op === 'spawn-settings-get' ? { defaultMode: 'read-only', revision: 0 }
          : message.op === 'approval-settings-get' ? { autoApprove: false, revision: 0 }
            : message.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' }
              : message.op === 'agent-operations' ? { operations: [] }
                : message.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : []
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/settings')
  const selector = page.getByRole('button', { name: /Codex server mode/ }).and(page.locator('[aria-haspopup="listbox"]'))
  const save = page.getByRole('button', { name: 'Save Codex server mode', exact: true })
  await expect(selector).toBeEnabled()
  await expect(save).toBeDisabled()
  await selector.click()
  await page.getByRole('option', { name: 'Shared servers', exact: true }).click()
  await save.click()
  await expect(page.getByText('Codex server mode saved.', { exact: true })).toBeVisible()
  expect(writes).toEqual([{ mode: 'shared', expectedRevision: 0 }])
  await page.reload()
  await expect(selector).toContainText('Shared servers')
  settings = { ...settings, mode: 'separate', revision: 2 }; broadcast()
  await expect(selector).toContainText('Separate servers')
  rejectSave = true
  await selector.click()
  await page.getByRole('option', { name: 'Shared servers', exact: true }).click()
  await save.click()
  await expect(page.getByRole('alert')).toContainText('Codex server settings changed elsewhere.')
  await page.reload()
  await expect(selector).toContainText('Separate servers')
})
