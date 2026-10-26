import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from './fixtures'

const license = 'a'.repeat(64)
function commandFixture() {
  const installed = 'C:\\Users\\tester\\AppData\\Local\\Aixand\\products\\bin\\uc.exe'
  const existing = 'C:\\Users\\tester\\.cargo\\bin\\uc.exe'
  return { userPathSupported: true, registered: false,
    profileNotice: 'PowerShell aliases, functions, and shell profiles can override PATH selection.',
    commands: [{ name: 'uc', suiteVersion: '0.1.0-beta', installedVersion: '0.1.0-beta', installedPath: installed,
      default: { path: existing, version: '2.0.0', managed: false }, conflict: true,
      candidates: [{ path: existing, version: '2.0.0', managed: false }, { path: installed, version: '0.1.0-beta', managed: true }] }] }
}
function pending(edition: 'standalone' | 'distributed') {
  return {
    available: true, ready: false, edition, job: null as null | { status: string; message?: string; product?: string; terminal?: ReturnType<typeof commandFixture> },
    licenses: [{ product: 'Undercurrent', sha256: license, text: 'Included test product terms.' }],
    assemblies: [
      { id: 'undercurrent', name: 'Undercurrent', versions: ['1.0'], installed: false },
      { id: 'runner', name: 'Runner', versions: ['1.0'], installed: false },
      { id: 'carrier', name: 'Carrier', versions: ['1.0'], installed: false },
      { id: 'manager-suite', name: 'Manager Suite', versions: ['1.0'], installed: false },
    ],
  }
}
async function hold(page: Page) {
  await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
  await page.route('**/api/auth/installation/commands', route => route.fulfill({ json: commandFixture() }))
}

test('the logo intro plays before the password and stays assembled through product setup', async ({ page }) => {
  await hold(page)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  let authenticated = false
  let releaseInstallation!: () => void
  const installationReady = new Promise<void>(resolve => { releaseInstallation = resolve })
  await page.route('**/api/auth/session', route => route.fulfill(authenticated
    ? { json: { authenticated: true, csrfToken: 'isolated-ui-csrf', expiresAt: Date.now() + 3600000 } }
    : { status: 401, json: {} }))
  await page.route('**/api/auth/status', route => route.fulfill({ json: { state: 'setup_pending' } }))
  await page.route('**/api/auth/setup', route => {
    authenticated = true
    return route.fulfill({ status: 201, json: {} })
  })
  await page.route('**/api/auth/installation/status', async route => {
    await installationReady
    await route.fulfill({ json: pending('distributed') })
  })
  await page.goto('/')
  await expect(page.locator('.onboarding-stage')).toHaveAttribute('data-phase', 'intro')
  await expect(page.locator('.onboarding-mark__core')).toHaveCSS('animation-name', 'aixand-core-arrive')
  await page.getByLabel('Password', { exact: true }).fill('onboarding password only 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('onboarding password only 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  try {
    await expect(page.getByRole('status')).toHaveText('Checking your installation…')
    // A slow installation check must wait with the assembled logo, without a fresh intro.
    expect(await page.locator('.onboarding-stage').getAttribute('data-phase')).toBe('waiting')
    expect(await page.locator('.onboarding-mark svg').evaluateAll(pieces =>
      pieces.every(piece => piece.getAnimations().length === 0))).toBe(true)
  } finally {
    releaseInstallation()
  }
  await expect(page.getByRole('heading', { name: 'Install your tools', exact: true })).toBeVisible()
  expect(await page.locator('.onboarding-mark svg').evaluateAll(pieces =>
    pieces.every(piece => piece.getAnimations().length === 0))).toBe(true)
})

test('distributed tool setup reviews terms, sends CSRF, and continues to existing setup', async ({ page }) => {
  await hold(page)
  let status = pending('distributed')
  let posts = 0
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: status }))
  await page.route('**/api/auth/installation/install', async route => {
    posts++
    expect(route.request().headers()['x-csrf-token']).toBe('isolated-ui-csrf')
    expect(route.request().postDataJSON()).toEqual({ acceptedLicenses: [license], terminalPolicy: 'keep' })
    status.assemblies[0].installed = true
    status = { ...status, job: { status: 'running', product: 'runner', message: 'Installing Runner' } }
    await route.fulfill({ status: 201, json: { started: true } })
  })
  await page.goto('/#/home')
  await expect(page.getByRole('heading', { name: 'Install your tools' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install tools' })).toBeDisabled()
  await page.getByText('I have reviewed and accept the product terms', { exact: true }).click()
  await page.getByRole('button', { name: 'Install tools' }).click()
  await expect(page.getByRole('status')).toContainText('Installing Runner')
  await expect(page.getByRole('heading', { name: 'Setting up your tools' })).toBeVisible()
  const products = page.getByRole('list', { name: 'Aixand products' })
  await expect(products.getByText('Installed', { exact: true })).toHaveCount(1)
  await expect(products.getByText('Installing…', { exact: true })).toHaveCount(1)
  await expect(products.getByText('Waiting', { exact: true })).toHaveCount(2)
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Setting up tools…' })).toBeDisabled()
  await page.screenshot({ path: test.info().outputPath('tools-installing.png') })
  expect(posts).toBe(1)
  status = { ...status, ready: true, job: { status: 'complete' },
    assemblies: status.assemblies.map(row => ({ ...row, installed: true })) }
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your tools are ready' })).toBeVisible()
  await expect(products.getByText('Installed', { exact: true })).toHaveCount(4)
  await expect(page.locator('.product-command-versions')).not.toBeVisible()
  await page.screenshot({ path: test.info().outputPath('tools-ready.png') })
  await page.getByRole('button', { name: 'Continue to agent setup' }).click()
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
})

for (const { policy, existing, userPathSupported } of [
  { policy: 'keep', existing: true, userPathSupported: true },
  { policy: 'prefer', existing: true, userPathSupported: true },
  { policy: 'prefer', existing: false, userPathSupported: true },
  { policy: 'keep', existing: false, userPathSupported: false },
] as const) test(`${existing ? 'existing' : 'new'} commands and ${policy} defaults are verified ${userPathSupported ? 'with' : 'without'} user PATH setup`, async ({ page }) => {
  await hold(page)
  if (!existing) await page.route('**/api/auth/installation/commands', route => {
    const commands = commandFixture()
    return route.fulfill({ json: { ...commands, userPathSupported,
      commands: commands.commands.map(row => ({ ...row, default: null, conflict: false, candidates: [] })) } })
  })
  await page.setViewportSize({ width: 390, height: 1000 })
  let status = pending('distributed')
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: status }))
  await page.route('**/api/auth/installation/install', async route => {
    expect(route.request().postDataJSON()).toEqual({ acceptedLicenses: [license], terminalPolicy: policy })
    const terminal = commandFixture()
    terminal.registered = true
    terminal.userPathSupported = userPathSupported
    if (!existing) {
      terminal.commands[0].candidates = terminal.commands[0].candidates.filter(candidate => candidate.managed)
      terminal.commands[0].conflict = false
      terminal.commands[0].default = terminal.commands[0].candidates[0]
    }
    if (policy === 'prefer') {
      terminal.commands[0].candidates.reverse()
      terminal.commands[0].default = terminal.commands[0].candidates[0]
    }
    status = { ...status, ready: true, assemblies: status.assemblies.map(row => ({ ...row, installed: true })),
      job: { status: 'complete', terminal, cliDirectory: 'C:\\Aixand\\products\\bin' } } as typeof status
    await route.fulfill({ status: 201, json: { started: true } })
  })
  await page.goto('/')
  const commands = page.getByRole('region', { name: 'Terminal commands' })
  if (existing) {
    await expect(commands.locator('.product-command-versions')).not.toBeVisible()
    await commands.getByText('Compare versions and locations', { exact: true }).click()
    await expect(commands).toContainText('2.0.0')
    await expect(commands).toContainText('0.1.0-beta')
    await expect(page.getByLabel('Use existing commands', { exact: true })).toBeEnabled()
    await expect(page.getByLabel('Use existing commands', { exact: true })).toBeChecked()
    if (policy === 'prefer') await page.getByText('Use newly installed commands', { exact: true }).click()
  } else if (userPathSupported) {
    await expect(page.getByRole('radio')).toHaveCount(0)
    await expect(commands).toContainText('Your terminal commands will be set up automatically.')
    await expect(commands).toContainText('No other installed commands were found.')
  } else {
    await expect(page.getByRole('radio', { name: 'Use existing commands', exact: true })).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'Use newly installed commands', exact: true })).toHaveCount(0)
  }
  await page.getByText('I have reviewed and accept the product terms', { exact: true }).click()
  await page.getByRole('button', { name: 'Install tools' }).click()
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toBeVisible()
  await page.getByText('Installation summary', { exact: true }).click()
  await commands.getByText('Compare versions and locations', { exact: true }).click()
  await expect(commands.getByText('New terminal default (PATH):', { exact: false })).toContainText(existing && policy === 'keep' ? '2.0.0' : '0.1.0-beta')
  await expect(page.getByText('Your user PATH is configured.', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.product-terminal-commands').analyze()).violations).toEqual([])
})

test('command inspection failures can be retried before changing terminal defaults', async ({ page }) => {
  await hold(page)
  let fail = true
  await page.route('**/api/auth/installation/commands', route => route.fulfill(fail
    ? { status: 503, json: { message: 'Command check failed' } } : { json: commandFixture() }))
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: pending('distributed') }))
  await page.goto('/')
  await page.getByText('I have reviewed and accept the product terms', { exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Could not check existing terminal commands')
  await expect(page.getByRole('button', { name: 'Install tools' })).toBeDisabled()
  fail = false
  await page.getByRole('button', { name: 'Retry command check' }).click()
  await expect(page.getByRole('button', { name: 'Install tools' })).toBeEnabled()
})

test('interrupted installs retain product progress and offer retry', async ({ page }) => {
  await hold(page)
  const status = pending('distributed')
  status.assemblies[0].installed = true
  status.job = { status: 'interrupted', product: 'runner', message: 'Setup was interrupted. Retry to resume.' }
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: status }))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Retry to resume')
  await expect(page.getByRole('list', { name: 'Aixand products' }).getByText('Installed', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('listitem').filter({ hasText: 'Runner' }).getByText('Needs attention')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry setup' })).toBeDisabled()
  await page.getByText('I have reviewed and accept the product terms', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry setup' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('tools-interrupted.png') })
})

for (const mode of ['light', 'dark'] as const) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 720 }]) {
    test(`tool setup stays accessible in ${mode} mode at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await hold(page)
      await page.setViewportSize(viewport)
      await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
      const status = pending('distributed')
      status.assemblies[2].installed = true
      await page.route('**/api/auth/installation/status', route => route.fulfill({ json: status }))
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Install your tools' })).toBeVisible()
      await expect(page.locator('.onboarding-fields')).toHaveCSS('opacity', '1')
      await expect(page.getByRole('navigation', { name: 'Setup progress' }).locator('[aria-current="step"]')).toHaveText('2Tools')
      await expect(page.getByRole('radio', { name: 'Use existing commands', exact: true })).toBeChecked()
      await expect(page.locator('.product-command-versions')).not.toBeVisible()
      const button = page.getByRole('button', { name: 'Install tools' })
      await expect(button).toBeDisabled()
      const bounds = (await button.boundingBox())!
      expect(bounds.y).toBeGreaterThan(0)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect((await new AxeBuilder({ page }).include('.product-onboarding').include('.product-setup-steps').analyze()).violations).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`tools-review-${mode}-${viewport.width}.png`) })
      const terms = page.getByText('View product terms', { exact: true })
      await terms.focus()
      await terms.press('Enter')
      await expect(page.getByText('Included test product terms.', { exact: true })).toBeVisible()
      await terms.press('Enter')
      await expect(page.getByText('Included test product terms.', { exact: true })).not.toBeVisible()
      const acceptance = page.getByRole('checkbox', { name: 'I have reviewed and accept the product terms' })
      await acceptance.focus()
      await acceptance.press('Space')
      await expect(acceptance).toBeChecked()
      await expect(button).toBeEnabled()
      const afterScroll = (await button.boundingBox())!
      expect(afterScroll.y + afterScroll.height).toBeLessThanOrEqual(viewport.height)
    })
  }
}

for (const width of [390, 1440]) test('standalone included products remain readable at ' + width, async ({ page }) => {
  await hold(page)
  await page.setViewportSize({ width, height: 1000 })
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: pending('standalone') }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your included tools' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Activate included tools' })).toBeDisabled()
  await expect(page.getByText('their commands stay private to Aixand.', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const audit = await new AxeBuilder({ page }).include('.product-onboarding').analyze()
  expect(audit.violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath('included-products.png') })
})

test('a previously completed installation opens the workspace without replaying setup', async ({ page }) => {
  await hold(page)
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: {
    ...pending('distributed'), ready: true, job: { status: 'complete' },
  } }))
  await page.goto('/#/home')
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install tools' })).toHaveCount(0)
})

test('an older completed Windows installation reviews command defaults once', async ({ page }) => {
  await hold(page)
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: {
    ...pending('distributed'), ready: true, commandSetupRequired: true, job: { status: 'complete' },
  } }))
  await page.goto('/#/home')
  await expect(page.getByRole('heading', { name: 'Install your tools' })).toBeVisible()
  await expect(page.getByLabel('Use existing commands', { exact: true })).toBeChecked()
  await expect(page.getByRole('region', { name: 'Terminal commands' })).toContainText('2.0.0')
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toHaveCount(0)
})

for (const selection of ['aixand-suite', 'default']) test(`connection setup reports the ${selection} CLI selection`, async ({ page }) => {
  await hold(page)
  let status = { ...pending('distributed'), ready: true, commandSetupRequired: false,
    connectionSetupRequired: true, ucConnection: null as null | { profile: string; activeProfile: string; home: string; verified: boolean },
    assemblies: pending('distributed').assemblies.map(row => ({ ...row, installed: true })),
  }
  await page.route('**/api/auth/installation/status', route => route.fulfill({ json: status }))
  await page.route('**/api/auth/installation/install', async route => {
    status = { ...status, connectionSetupRequired: false, job: { status: 'complete' },
      ucConnection: { profile: 'aixand-suite', activeProfile: selection, home: 'C:\\Aixand\\local\\uc', verified: true } }
    await route.fulfill({ status: 201, json: { started: true } })
  })
  await page.goto('/#/home')
  await expect(page.getByRole('heading', { name: 'Install your tools' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toHaveCount(0)
  await page.getByText('I have reviewed and accept the product terms', { exact: true }).click()
  await page.getByRole('button', { name: 'Install tools' }).click()
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toBeVisible()
  await page.getByText('Installation summary', { exact: true }).click()
  await expect(page.getByText('CLI selection after setup:', { exact: false })).toContainText(selection)
  await expect(page.getByText('uc settings set profile default', { exact: true })).toBeVisible()
  await expect(page.getByText('uc settings set profile aixand-suite', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to agent setup' })).toBeVisible()
})
