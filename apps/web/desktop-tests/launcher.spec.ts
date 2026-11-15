import { test, expect } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'

type Settings = {
  profiles: { id: string; name: string; address: string; local?: boolean }[]
  selectedId: string
  autoConnect: boolean
}
type NativeFixture = {
  settings: Settings; saves: Settings[]; unavailable: boolean; reloads: boolean[]; localAvailable: boolean
  configured: boolean; toolsReady: boolean; setupMode: string; reuseConfig: boolean; failSettingsSave: boolean
  setupCalls: { action: string; options: Record<string, unknown> }[]; commands: string[]
  cleanupCalls: Record<string, unknown>[]; cleanupFailure: string | null
  cleanupActions: { action?: string; options?: Record<string, unknown> }[]
  cleanupBlockers: { pid: number; birth: string; name: string; executable: string; canStop: boolean; components: string[]; paths: string[];
    canForce?: boolean; service?: string; reason?: string }[]
  cleanupNeedsForce: boolean
  cleanupPermissionReview: { component: string; path: string; identity: { file: string } }[]
  cleanupUacCancelled: boolean
  automaticDownload?: boolean
  updateCalls: { action?: string; options?: Record<string, unknown> }[]
  notify: (event: { payload: { kind: string; message: string } }) => void
}
declare global { interface Window { desktopFixture: NativeFixture } }

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search)
    const profiles: Settings['profiles'] = params.has('fresh') ? [] : [{ id: 'default', name: params.has('legacy') ? 'My Aixand workspace' : 'My Linux workspace', address: 'http://127.0.0.1:8753/' }]
    if (params.has('selectedLocal')) profiles.push({ id: 'local', name: 'Local workspace', address: 'http://127.0.0.1:8753/', local: true })
    const fixture: NativeFixture = {
      settings: { profiles, selectedId: params.has('selectedLocal') ? 'local' : profiles[0]?.id || '', autoConnect: params.has('auto') },
      saves: [], unavailable: false, reloads: [], localAvailable: params.has('local'), notify: () => {},
      configured: params.has('configured'), toolsReady: params.has('toolsReady'), setupMode: params.has('shared') ? 'shared' : 'isolated',
      reuseConfig: false, failSettingsSave: false, setupCalls: [], commands: [], cleanupCalls: [], cleanupFailure: null,
      cleanupActions: [], cleanupBlockers: [], cleanupNeedsForce: false,
      cleanupPermissionReview: [], cleanupUacCancelled: false, updateCalls: [],
    }
    window.desktopFixture = fixture
    Object.defineProperty(window, '__TAURI__', { value: {
      core: { invoke: async (command: string, args: { settings?: Settings; reload?: boolean; action?: string; options?: Record<string, unknown> } = {}) => {
        fixture.commands.push(command === 'local_runtime_setup' ? `${command}:${args.action}` : command)
        if (command === 'application_updates' && (params.has('updates') || params.has('client'))) {
          fixture.updateCalls.push({ action: args.action, options: args.options })
          if (args.action === 'settings' && typeof args.options?.automaticDownload === 'boolean') fixture.automaticDownload = args.options.automaticDownload
          if (args.action === 'plan') return { revision: 'a'.repeat(64), ready: true, sessions: [], licenses: [], requiredProducts: [{ id: 'runner', version: '0.1.0-beta' }] }
          if (args.action === 'install') return { started: true }
          return { available: true, daily: args.options?.daily ?? true, automaticDownload: fixture.automaticDownload ?? false, phase: 'downloaded', updateAvailable: true, checkedAt: Date.now(),
            installed: { version: '0.1.0-beta', sequence: 1 }, release: { sequence: 2, notes: 'Fixture release notes.' }, message: 'Update downloaded.' }
        }
        if (command === 'component_updates') {
          fixture.updateCalls.push({ action: args.action, options: args.options })
          if (args.action === 'plan') return { revision: 'b'.repeat(64), ready: true, requested: ['server'], candidates: { server: { version: '0.1.1-beta' }, connect: { version: '0.2.0-beta' } }, licenses: [], blockers: [], unsupported: [], restartRequired: true }
          if (args.action === 'install') return { started: true }
          return { available: true, daily: true, automaticDownload: false, phase: 'downloaded', requested: ['server'], inventory: { components: { server: { version: '0.1.0-beta' } } } }
        }
        if (command === 'cleanup_context') return { uninstall: params.has('uninstall'), desktopSelected: params.has('deleteDesktop') }
        if (command === 'cleanup_finish') { fixture.cleanupCalls.push(args as Record<string, unknown>); return null }
        if (command === 'cleanup_components') {
          if (args.action === 'plan') return { revision: 'fixture-review', notice: 'Selected data is permanently deleted.', items: [
            { id: 'desktop', group: 'Aixand', label: 'Desktop connections and browser data', available: true, shared: false, description: 'Clear desktop sign-ins.', paths: ['/home/alice/desktop'] },
            { id: 'workspace', group: 'Aixand', label: 'Workspace data and password', available: true, shared: false, description: 'Delete workspace data.', paths: ['/home/alice/suite'] },
            { id: 'provider-accounts', group: 'Providers', label: 'Aixand provider accounts and settings', available: true, shared: false, description: 'Delete saved accounts.', paths: ['/home/alice/suite/agents'] },
            { id: 'product:undercurrent', group: 'Independent tools', label: 'Undercurrent', available: true, shared: true, description: 'Other applications will be affected.', paths: ['/home/alice/products'] },
            { id: 'provider:unknown', group: 'Providers', label: 'Unknown CLI', available: false, shared: true, description: 'Remove manually.', paths: ['/external/cli'] },
            ...(params.has('missingCodex') ? [{ id: 'native:codex', group: 'Shared provider accounts', label: 'Codex shared logins and data',
              available: fixture.cleanupActions.some(action => action.action === 'restore-provider'), shared: true,
              description: 'Restore the official CLI before sign-out.', paths: ['/home/alice/.codex'],
              ...(!fixture.cleanupActions.some(action => action.action === 'restore-provider')
                ? { recovery: { provider: 'codex', label: 'Restore official Codex CLI (shared)' } } : {}) }] : []),
          ] }
          fixture.cleanupActions.push(structuredClone({ action: args.action, options: args.options }))
          if (args.action === 'restore-provider') return { restored: 'codex', refreshRequired: true }
          if (args.action === 'repair-permissions') {
            if (fixture.cleanupUacCancelled) throw 'Windows administrator approval was cancelled. Nothing was removed.'
            fixture.cleanupPermissionReview = []
            return { blocked: false, blockers: [], errors: [], permissionsRepaired: true }
          }
          if (args.action === 'stop-processes') {
            if (args.options?.force || !fixture.cleanupNeedsForce) fixture.cleanupBlockers = []
            return { blocked: fixture.cleanupBlockers.length > 0, blockers: fixture.cleanupBlockers, errors: [], attempted: true }
          }
          if (fixture.cleanupPermissionReview.length) return { blocked: true, completed: [], blockers: [], failed: null,
            errors: fixture.cleanupPermissionReview.map(item => ({ path: item.path, message: 'Access is denied.', winerror: 5 })),
            permissionReview: fixture.cleanupPermissionReview, canRepairPermissions: true }
          if (fixture.cleanupBlockers.length) return { blocked: true, completed: [], blockers: fixture.cleanupBlockers, errors: [], failed: null }
          fixture.cleanupCalls.push(structuredClone(args.options || {}))
          return { completed: args.options?.selected || [], failed: fixture.cleanupFailure }
        }
        if (command === 'connection_settings') return structuredClone(fixture.settings)
        if (command === 'client_reset') return null
        if (command === 'local_runtime_info') return { role: params.has('client') ? 'client' : 'desktop', available: fixture.localAvailable, address: 'http://127.0.0.1:8753/' }
        if (command === 'local_runtime_setup') {
          const { action = 'info', options = {} } = args
          if (action === 'info') return { selectionRequired: params.has('chooseInstallation') && !fixture.setupCalls.some(call => call.action === 'choose'), configured: fixture.configured, setupMode: fixture.setupMode,
            installation: { edition: 'distributed', ready: fixture.toolsReady, onboardInWorkspace: true } }
          if (action === 'discover') return { found: params.has('existingTools'), tools: params.has('existingTools') ? [{ name: 'agent', path: '/home/alice/.local/bin/agent' }] : [], data: [], undercurrent: { home: '/home/alice/.aixand/undercurrent' } }
          fixture.setupCalls.push({ action, options: structuredClone(options) })
          if (action === 'choose') {
            if (!['shared', 'isolated'].includes(String(options.mode))) throw 'Invalid installation mode'
            if (options.settings !== (options.mode === 'isolated' ? 'fresh' : 'reuse')) throw 'Invalid settings selection'
            fixture.configured = true
            fixture.setupMode = String(options.mode)
            return { schema: 2, mode: options.mode }
          }
          if (action === 'stop') return { stopped: true }
          throw 'Unsupported installation action'
        }
        if (command === 'select_local_workspace') {
          if (!fixture.settings.profiles.some(profile => profile.local)) {
            fixture.settings.profiles.push({ id: 'local', name: 'Local workspace', address: 'http://127.0.0.1:8753/', local: true })
          }
          fixture.settings.selectedId = fixture.settings.profiles.find(profile => profile.local)!.id
          return structuredClone(fixture.settings)
        }
        if (command === 'save_connection_settings') {
          if (fixture.failSettingsSave) throw 'Could not write connection settings.'
          fixture.settings = structuredClone(args.settings!)
          fixture.saves.push(structuredClone(fixture.settings))
          return structuredClone(fixture.settings)
        }
        if (command === 'connect_workspace') {
          fixture.reloads.push(Boolean(args.reload))
          if (fixture.unavailable) throw 'Cannot reach Aixand. Check your server and SSH tunnel.'
          return null
        }
        throw new Error(`Unexpected command: ${command}`)
      } },
      event: { listen: async (_event: string, handler: NativeFixture['notify']) => { fixture.notify = handler; return () => {} } },
    } })
  })
})

test('cleanup checklist starts unchecked, explains shared tools and cancels without mutation', async ({ page }) => {
  await page.goto('/?local&fresh')
  await page.locator('#local-setup > summary').click()
  await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('input:checked')).toHaveCount(0)
  await expect(dialog.getByText('Other applications will be affected.')).toBeVisible()
  await expect(dialog.getByText('/home/alice/products')).toBeVisible()
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(dialog.locator('#cleanup-items input:checked')).toHaveCount(4)
  await expect(page.getByLabel('Unknown CLI (shared)', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  await expect(dialog).not.toBeVisible()
})

test('cleanup forwards only confirmed selected IDs and keeps other choices unchecked', async ({ page }) => {
  await page.goto('/?local&fresh')
  await page.locator('#local-setup > summary').click()
  await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  await page.getByLabel('Workspace data and password', { exact: true }).check()
  await page.locator('#cleanup-confirm').check()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([{ selected: ['workspace'], revision: 'fixture-review', confirmed: true }])
})

test('uninstall mode never auto-connects and supports app-only uninstall', async ({ page }) => {
  await page.goto('/?local&auto&uninstall')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Uninstall app only', exact: true }).click()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([])
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([{ proceed: true }])
})

test('escaping the uninstall checklist cancels the uninstaller', async ({ page }) => {
  await page.goto('/?local&uninstall')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([{ proceed: false }])
})

test('uninstall checklist reflects an earlier browser-data choice and allows keeping it instead', async ({ page }) => {
  await page.goto('/?local&uninstall&deleteDesktop')
  await expect(page.getByLabel('Desktop connections and browser data', { exact: true })).toBeChecked()
  await page.getByLabel('Desktop connections and browser data', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Uninstall app only', exact: true }).click()
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([{ proceed: true }])
})

test('cleanup checklist is accessible and fits narrow screens', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/?local&fresh')
  await page.locator('#local-setup > summary').click()
  await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.locator('#cleanup-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cleanup-checklist.png') })
})

test('partial cleanup failure stays open and requires refreshing the checklist', async ({ page }) => {
  await page.goto('/?local&fresh')
  await page.locator('#local-setup > summary').click()
  await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  await page.evaluate(() => { window.desktopFixture.cleanupFailure = 'Official logout failed' })
  await page.getByLabel('Aixand provider accounts and settings', { exact: true }).check()
  await page.locator('#cleanup-confirm').check()
  await page.getByRole('button', { name: 'Remove selected', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#cleanup-message')).toContainText('Official logout failed')
  await expect(page.getByRole('button', { name: 'Remove selected', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Refresh checklist', exact: true }).click()
  await expect(page.locator('#cleanup-items input:checked')).toHaveCount(0)
})

async function openBlockedCleanup(page: import('@playwright/test').Page, query = '/?local&fresh') {
  await page.goto(query)
  if (!query.includes('uninstall')) {
    await page.locator('#local-setup > summary').click()
    await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  }
  await page.evaluate(() => {
    window.desktopFixture.cleanupBlockers = [{ pid: 987, birth: 'fixture-process-start', name: 'Codex background helper',
      executable: 'C:\\Tools\\codex.exe', canStop: true, components: ['workspace'],
      paths: ['C:\\Users\\alice\\.codex\\.codex-provisioning-fixture.guard'] }]
  })
  await page.getByLabel('Workspace data and password', { exact: true }).check()
  await page.locator('#cleanup-confirm').check()
  await page.locator('#cleanup-apply').click()
  await expect(page.locator('#cleanup-blockers')).toBeVisible()
}

test('missing shared Codex CLI can be restored without selecting or deleting account data', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/?local&missingCodex')
  await page.getByRole('tab', { name: 'This computer' }).click()
  await page.locator('#local-setup > summary').click()
  await page.getByRole('button', { name: 'Reset or remove components…' }).click()
  await expect(page.getByLabel('Codex shared logins and data (shared)', { exact: true })).toBeDisabled()
  expect(await page.locator('#cleanup-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Restore official Codex CLI (shared)' }).click()
  await expect(page.getByLabel('Codex shared logins and data (shared)', { exact: true })).toBeEnabled()
  await expect(page.getByLabel('Codex shared logins and data (shared)', { exact: true })).not.toBeChecked()
  expect(await page.evaluate(() => window.desktopFixture.cleanupActions)).toEqual([{ action: 'restore-provider', options: { provider: 'codex', revision: 'fixture-review', confirmed: true } }])
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
})

for (const cancel of [false, true]) test(`cleanup permission repair ${cancel ? 'keeps data when administrator approval is cancelled' : 'requires a reviewed action before removal'}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto('/?uninstall')
  await page.evaluate(cancelled => {
    window.desktopFixture.cleanupUacCancelled = cancelled
    window.desktopFixture.cleanupPermissionReview = [{ component: 'provider-accounts',
      path: 'C:\\Users\\alice\\Aixand\\agents\\opencode\\sdk-runs\\fixture.json', identity: { file: 'reviewed-file-id' } }]
  }, cancel)
  await page.getByLabel('Aixand provider accounts and settings', { exact: true }).check()
  await page.locator('#cleanup-confirm').check()
  await page.locator('#cleanup-apply').click()
  const repair = page.getByRole('button', { name: 'Repair access as administrator and retry', exact: true })
  await expect(repair).toBeVisible()
  await expect(page.locator('#cleanup-blockers-help')).toContainText('changes permissions only')
  await expect(page.locator('#cleanup-stop')).toBeHidden()
  expect(await page.locator('#cleanup-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  await repair.click()
  const actions = await page.evaluate(() => window.desktopFixture.cleanupActions)
  expect(actions.map(call => call.action)).toEqual(cancel ? ['apply', 'repair-permissions'] : ['apply', 'repair-permissions', 'apply'])
  expect(actions[1].options?.selected).toEqual(['provider-accounts'])
  expect(actions[1].options?.reviewedPermissions).toEqual([{ component: 'provider-accounts',
    path: 'C:\\Users\\alice\\Aixand\\agents\\opencode\\sdk-runs\\fixture.json', identity: { file: 'reviewed-file-id' } }])
  if (cancel) {
    await expect(page.locator('#cleanup-message')).toContainText('administrator approval was cancelled')
    expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  } else {
    expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([
      { selected: ['provider-accounts'], revision: 'fixture-review', confirmed: true }, { proceed: true }])
  }
})

test('blocked cleanup lists background processes and requires a separate action before stopping them', async ({ page }) => {
  await openBlockedCleanup(page)
  await expect(page.locator('#cleanup-blocker-list')).toContainText('Codex background helper — PID 987')
  await expect(page.locator('#cleanup-blocker-list')).toContainText('.codex-provisioning-fixture.guard')
  await expect(page.locator('#cleanup-message')).toContainText('Nothing was removed or signed out')
  await expect(page.locator('#cleanup-force-options')).toBeHidden()
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  expect(await page.evaluate(() => window.desktopFixture.cleanupActions.map(call => call.action))).toEqual(['apply'])
  await page.getByRole('button', { name: 'Stop and retry', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const actions = await page.evaluate(() => window.desktopFixture.cleanupActions)
  expect(actions.map(call => call.action)).toEqual(['apply', 'stop-processes', 'apply'])
  expect(actions[1].options).toEqual({ selected: ['workspace'], revision: 'fixture-review', confirmed: true,
    reviewed: [{ pid: 987, birth: 'fixture-process-start' }], force: false, forceConfirmed: false })
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([{ selected: ['workspace'], revision: 'fixture-review', confirmed: true }])
})

test('force stop is offered after graceful stop and needs its own acknowledgement', async ({ page }, testInfo) => {
  await openBlockedCleanup(page)
  await page.evaluate(() => { window.desktopFixture.cleanupNeedsForce = true })
  await page.getByRole('button', { name: 'Stop and retry', exact: true }).click()
  await expect(page.locator('#cleanup-force-options')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Force stop and retry', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('cleanup-blockers.png') })
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  await page.locator('#cleanup-force-confirm').check()
  await page.getByRole('button', { name: 'Force stop and retry', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.cleanupActions.findLast(call => call.action === 'stop-processes')?.options)).toMatchObject({
    reviewed: [{ pid: 987, birth: 'fixture-process-start' }], force: true, forceConfirmed: true,
  })
})

test('changing selected components invalidates the old blocker review', async ({ page }) => {
  await openBlockedCleanup(page)
  await page.getByLabel('Workspace data and password', { exact: true }).uncheck()
  await expect(page.locator('#cleanup-blockers')).toBeHidden()
  await expect(page.locator('#cleanup-stop')).toBeDisabled()
  expect(await page.evaluate(() => window.desktopFixture.cleanupActions.map(call => call.action))).toEqual(['apply'])
})

test('Codex sandbox service offers graceful stop with administrator explanation and no force action', async ({ page }) => {
  await openBlockedCleanup(page)
  await page.evaluate(() => {
    Object.assign(window.desktopFixture.cleanupBlockers[0], { name: 'Codex Windows sandbox service',
      service: 'CodexSandboxService.OpenAI.Codex', canForce: false,
      reason: 'Windows will request administrator approval to stop this Codex sandbox service.' })
    window.desktopFixture.cleanupNeedsForce = true
  })
  await page.getByRole('button', { name: 'Check and retry', exact: true }).click()
  await expect(page.locator('#cleanup-blocker-list')).toContainText('administrator approval')
  await page.getByRole('button', { name: 'Stop and retry', exact: true }).click()
  await expect(page.locator('#cleanup-force-options')).toBeHidden()
  await expect(page.locator('#cleanup-stop')).toBeEnabled()
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
})

test('blocked uninstall waits for successful cleanup and fits an accessible narrow dialog', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await openBlockedCleanup(page, '/?local&uninstall')
  expect(await page.evaluate(() => window.desktopFixture.cleanupCalls)).toEqual([])
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.locator('#cleanup-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Stop and retry', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.cleanupCalls.at(-1))).toEqual({ proceed: true })
})

test('packaged setup opens workspace onboarding without removed tool controls', async ({ page }) => {
  await page.goto('/?local&fresh&edition=distributed')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
  await page.locator('#local-setup > summary').click()
  await expect(page.getByLabel('Tools', { exact: true })).toHaveCount(0)
  await expect(page.locator('#setup-message')).toContainText('this Suite workspace')
})

test('opens without a server and retries an unavailable connection', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await expect(page.getByRole('tablist')).toBeHidden()
  await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('http://127.0.0.1:8753/')
  await page.evaluate(() => { window.desktopFixture.unavailable = true })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Cannot connect', { exact: true })).toBeVisible()
  await page.evaluate(() => { window.desktopFixture.unavailable = false })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([false, false])
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
})

test('reopening a selected local workspace does not rewrite its installation plan', async ({ page }) => {
  await page.goto('/?local&fresh&configured')
  await expect(page.getByRole('tab', { name: 'This computer' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#local-setup')).not.toHaveAttribute('open', '')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.reloads.length)).toBe(2)
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
})

test('keeps saved servers separate from the local workspace and preserves drafts', async ({ page }) => {
  await page.goto('/?local&configured')
  await page.getByRole('tab', { name: 'This computer' }).click()
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Server', exact: true }).click()
  await expect(page.getByLabel('Saved servers')).toHaveValue('default')
  await expect(page.getByLabel('Saved servers').getByRole('option')).toHaveCount(2)
  await page.getByLabel('Saved servers').selectOption('new')
  await page.getByLabel('Server address').fill('https://office.example/')
  await page.getByLabel('Saved servers').selectOption('default')
  await page.getByLabel('Saved servers').selectOption('new')
  await expect(page.getByLabel('Server address')).toHaveValue('https://office.example/')
  await page.getByRole('tab', { name: 'This computer' }).click()
  await page.getByRole('tab', { name: 'Server', exact: true }).click()
  await expect(page.getByLabel('Server address')).toHaveValue('https://office.example/')
  expect(await page.evaluate(() => window.desktopFixture.settings.profiles)).toHaveLength(2)
})

test('preserves shared installation ownership and can stop its local services', async ({ page }) => {
  await page.goto('/?local&fresh&configured&shared')
  await page.locator('#local-setup > summary').click()
  await expect(page.locator('#setup-message')).toContainText('shared manager stores')
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
  await page.getByRole('button', { name: 'Stop local services', exact: true }).click()
  await expect(page.locator('#setup-message')).toHaveText('Local services stopped.')
  await page.evaluate(() => window.desktopFixture.notify({ payload: { kind: 'disconnected', message: 'Server stopped.' } }))
  await expect(page.locator('#status-title')).toHaveText('Local services stopped')
})

test('remembers a server on connect and derives its name when none is given', async ({ page }) => {
  await page.goto('/?fresh')
  await expect(page.getByLabel('Saved servers')).toBeHidden()
  await page.getByLabel('Server address').fill('https://office.example')
  await page.getByLabel('Open automatically next time').check()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  const settings = await page.evaluate(() => window.desktopFixture.settings)
  expect(settings.profiles).toHaveLength(1)
  expect(settings.profiles[0]).toMatchObject({ name: 'office.example', address: 'https://office.example/' })
  expect(settings.autoConnect).toBe(true)
  await expect(page.getByLabel('Saved servers')).toBeVisible()
})

test('remembers optional names as text and can forget the final saved server', async ({ page }) => {
  await page.goto('/?fresh')
  await page.getByLabel('Server address').fill('https://suite.example/')
  await page.locator('#server-options > summary').click()
  await page.getByLabel('Name (optional)').fill('<img src=x onerror=alert(1)>')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.locator('img').count()).toBe(0)
  await expect(page.getByLabel('Saved servers').getByRole('option').first()).toHaveText('<img src=x onerror=alert(1)>')
  await page.getByRole('button', { name: 'Forget server', exact: true }).click()
  await expect(page.getByText('Server forgotten', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Saved servers')).toBeHidden()
  await expect(page.getByLabel('Server address')).toHaveValue('')
})

test('keeps a saved server when forgetting it fails', async ({ page }) => {
  await page.goto('/')
  await page.locator('#server-options > summary').click()
  await page.evaluate(() => { window.desktopFixture.failSettingsSave = true })
  await page.getByRole('button', { name: 'Forget server', exact: true }).click()
  await expect(page.getByText('Could not forget server', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Saved servers')).toHaveValue('default')
  expect(await page.evaluate(() => window.desktopFixture.settings.profiles)).toHaveLength(1)
})

test('shows connection loss and reloads only when Reconnect is chosen', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await page.evaluate(() => window.desktopFixture.notify({ payload: { kind: 'disconnected', message: 'Your SSH tunnel is unavailable.' } }))
  await expect(page.getByText('Connection lost', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([false])
  await page.evaluate(() => window.desktopFixture.notify({ payload: { kind: 'restored', message: 'The server is reachable again.' } }))
  await expect(page.getByText('Server available', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([false, true])
})

test('uses the saved automatic connection for both server and local workspaces', async ({ page }) => {
  await page.goto('/?auto')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([false])
  await page.goto('/?auto&local&configured&selectedLocal')
  await expect(page.getByRole('tab', { name: 'This computer' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.reloads)).toEqual([false])
})

test('preserves an existing server that uses the old default name and address', async ({ page }) => {
  await page.goto('/?local&legacy&auto')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Server', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Saved servers')).toHaveValue('default')
  expect(await page.evaluate(() => window.desktopFixture.settings.profiles)).toHaveLength(1)
  expect(await page.evaluate(() => window.desktopFixture.setupCalls)).toEqual([])
})

test('saves automatic opening immediately for an existing destination', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Open automatically next time').check()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.settings.autoConnect)).toBe(true)
  await page.evaluate(() => { window.desktopFixture.failSettingsSave = true })
  await page.getByLabel('Open automatically next time').click()
  await expect(page.getByText('Could not save preference', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Open automatically next time')).toBeChecked()
})

test('supports keyboard navigation between workspace tabs', async ({ page }) => {
  await page.goto('/?local&fresh')
  await page.getByRole('tab', { name: 'This computer' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Server', exact: true })).toBeFocused()
  await expect(page.getByLabel('Server address')).toBeVisible()
  await page.keyboard.press('Home')
  await expect(page.getByRole('tab', { name: 'This computer' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toBeVisible()
})

test('Desktop updates require a reviewed release and explicit consent', async ({ page }) => {
  await page.goto('/?updates')
  await expect(page.getByText('Installed: 0.1.0-beta · revision 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review update', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Install application update' })
  const install = dialog.getByRole('button', { name: 'Install and restart', exact: true })
  await expect(install).toBeDisabled()
  await page.setViewportSize({ width: 320, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath('desktop-update-review.png'), fullPage: true })
  await dialog.getByLabel('I agree to the displayed product licenses and shared tool changes.').check()
  await expect(install).toBeDisabled()
  await dialog.getByLabel('I approve closing this application and the reviewed restart impact.').check()
  await install.click()
  const calls = await page.evaluate(() => window.desktopFixture.updateCalls)
  expect(calls.find(row => row.action === 'install')?.options).toEqual({ confirmed: true, revision: 'a'.repeat(64), acceptedLicenses: [], restartConsent: true })
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`launcher remains accessible and fits narrow screens in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 640, height: 720 })
    await page.goto('/?local&fresh')
    await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toBeEnabled()
    await page.screenshot({ path: `/tmp/aixand-launcher-${colorScheme}-local.png`, fullPage: true })
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
    await page.getByRole('tab', { name: 'Server', exact: true }).click()
    await page.screenshot({ path: `/tmp/aixand-launcher-${colorScheme}-server.png`, fullPage: true })
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
    await page.setViewportSize({ width: 320, height: 720 })
    await page.locator('#server-options > summary').click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('tab', { name: 'This computer' }).click()
    await page.locator('#local-setup > summary').click()
    await expect(page.getByRole('button', { name: 'Stop local services', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/aixand-launcher-${colorScheme}-narrow-advanced.png`, fullPage: true })
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([])
  })
}


test('Client exposes only Server connections and resets without runtime maintenance', async ({ page }) => {
  await page.goto('/?fresh&client')
  await expect(page.getByLabel('Server address', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'This computer' })).toBeHidden()
  await page.getByText('Client settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear Client data…' }).click()
  await page.getByRole('button', { name: 'Clear Client data', exact: true }).click()
  await expect(page.getByText('Client data cleared', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.desktopFixture.commands)
  expect(calls).toContain('client_reset')
  expect(calls.some(call => call.startsWith('local_runtime_setup') || call === 'select_local_workspace' || call === 'component_updates')).toBe(false)
})


test('fresh product setup asks only for installation location and saves the default before starting', async ({ page }) => {
  await page.goto('/?fresh&local&edition=distributed&chooseInstallation')
  await expect(page.locator('#installation-choice')).toBeVisible()
  await expect(page.locator('#installation-review-removal')).toBeHidden()
  await expect(page.getByText('Separate Suite installation (recommended)', { exact: true })).toBeVisible()
  await page.locator('#local-workspace').click()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.setupCalls.find(call => call.action === 'choose')?.options)).toEqual({ mode: 'isolated', settings: 'fresh' })
  const commands = await page.evaluate(() => window.desktopFixture.commands)
  expect(commands.indexOf('local_runtime_setup:choose')).toBeLessThan(commands.indexOf('connect_workspace'))
})

test('detected installations offer reuse, optional cleanup and a separate Suite installation', async ({ page }) => {
  await page.goto('/?fresh&local&edition=distributed&chooseInstallation&existingTools')
  await expect(page.getByText('Use existing shared setup', { exact: true })).toBeVisible()
  await page.locator('#installation-review-removal').click()
  await expect(page.locator('#cleanup-dialog')).toBeVisible()
  await page.locator('#cleanup-cancel').click()
  await page.locator('input[name="installation-mode"][value="shared"]').check()
  await page.locator('#local-workspace').click()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.setupCalls.find(call => call.action === 'choose')?.options)).toEqual({ mode: 'shared', settings: 'reuse' })
})

test('a reset local workspace waits for a mode choice even when automatic connection was enabled', async ({ page }) => {
  await page.goto('/?local&selectedLocal&auto&edition=distributed&chooseInstallation')
  await expect(page.locator('#installation-choice')).toBeVisible()
  expect(await page.evaluate(() => window.desktopFixture.commands.includes('connect_workspace'))).toBe(false)
})


test('Client reviews a native application update without invoking a local runtime', async ({ page }) => {
  await page.goto('/?client&updates')
  await page.getByRole('button', { name: 'Review update', exact: true }).click()
  await page.locator('#update-consent').check()
  await expect(page.locator('#update-install')).toBeDisabled()
  await page.locator('#update-restart').check()
  await page.locator('#update-install').click()
  const calls = await page.evaluate(() => window.desktopFixture.commands)
  expect(calls).toContain('application_updates')
  expect(calls.some(call => call.startsWith('local_runtime_setup') || call === 'component_updates')).toBe(false)
})

test('local component review includes companions and requires restart consent', async ({ page }) => {
  await page.goto('/?local&configured&toolsReady')
  await page.locator('#component-updates > summary').click()
  await page.getByRole('button', { name: 'Review selected components' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review component updates' })
  await expect(dialog.getByText('connect: 0.2.0-beta (companion update)', { exact: true })).toBeVisible()
  await dialog.locator('#component-consent').check()
  await expect(dialog.locator('#component-install')).toBeDisabled()
  await dialog.locator('#component-restart').check()
  await dialog.locator('#component-install').click()
  expect((await page.evaluate(() => window.desktopFixture.updateCalls)).find(row => row.action === 'install')?.options)
    .toEqual({ confirmed: true, revision: 'b'.repeat(64), acceptedLicenses: [], restartConsent: true })
})


test('Client automatic downloads are opt-in and never imply installation', async ({ page }) => {
  await page.goto('/?client&updates')
  const automatic = page.locator('#update-auto')
  await expect(automatic).not.toBeChecked()
  await automatic.check()
  await expect.poll(() => page.evaluate(() => window.desktopFixture.updateCalls.some(call => call.action === 'settings' && call.options?.automaticDownload === true))).toBe(true)
  await expect(automatic).toBeChecked()
  expect(await page.evaluate(() => window.desktopFixture.updateCalls.some(call => call.action === 'install'))).toBe(false)
})
