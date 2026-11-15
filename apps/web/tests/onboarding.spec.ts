import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from './fixtures'

async function workspace(page: Page, mode: 'light' | 'dark' = 'light') {
  await page.addInitScript((mode) => {
    localStorage.setItem('aixand.appearance', mode)
  }, mode)
  await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
  await page.goto('/tests/onboarding-preview.html#/home')
  await expect(
    page.getByRole('heading', { name: 'Home', exact: true }),
  ).toBeVisible()
}

async function open(page: Page) {
  await page.getByRole('button', { name: 'Open onboarding preview', exact: true }).click()
}

for (const state of ['configured', 'setup_pending']) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 960, height: 700 }, { width: 390, height: 720 }]) {
    test(`${state} form stays centered after the intro without resizing at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.route('**/api/auth/session', route => route.fulfill({ status: 401, json: {} }))
      await page.route('**/api/auth/status', route => route.fulfill({ json: { state } }))
      await page.goto('/')
      await expect(page.getByRole('heading', {
        name: state === 'configured' ? 'Sign in to your Suite' : 'Set up your password', exact: true,
      })).toBeVisible()
      await expect(page.locator('.onboarding-fields')).toHaveCSS('opacity', '1')
      const centeringError = () => page.locator('.onboarding-stage').evaluate(stage => {
        const top = stage.querySelector('.onboarding-topline')!.getBoundingClientRect()
        const footer = stage.querySelector('.onboarding-footer')!.getBoundingClientRect()
        const splash = stage.querySelector('.onboarding-splash')!.getBoundingClientRect()
        const fields = stage.querySelector('.onboarding-fields')!.getBoundingClientRect()
        return Math.abs((splash.top + fields.bottom) / 2 - (top.bottom + footer.top) / 2)
      })
      await expect.poll(centeringError).toBeLessThan(2)
      if (state === 'configured') {
        await page.getByRole('button', { name: 'Forgot password?' }).click()
        await expect(page.getByRole('heading', { name: 'Recover your password' })).toBeVisible()
        await expect.poll(centeringError).toBeLessThan(2)
      }
    })
  }
}

test('the onboarding fixture replays the mark, previews both forms, and preserves the workspace', async ({
  page,
}) => {
  await workspace(page)
  const url = page.url()
  const app = await page.locator('.aixand-app').elementHandle()
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  const mutations: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && /\/api\//.test(request.url()))
      mutations.push(request.url())
  })
  await open(page)
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText(
    'Welcome to Aixand',
  )
  await expect(page.locator('.onboarding-mark__shell')).toHaveCSS(
    'animation-name',
    'aixand-shell-arrive',
  )
  await expect(page.locator('.onboarding-mark__core')).toHaveCSS(
    'animation-name',
    'aixand-core-arrive',
  )
  const mark = await page.locator('.onboarding-mark').elementHandle()
  const initialMark = await mark!.boundingBox()
  const positions = await page
    .locator('.onboarding-mark')
    .evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = 0
      }
      const shell = element
        .querySelector('.onboarding-mark__shell')!
        .getBoundingClientRect()
      const core = element
        .querySelector('.onboarding-mark__core')!
        .getBoundingClientRect()
      return {
        shellBottom: shell.bottom,
        coreTop: core.top,
        height: innerHeight,
      }
    })
  expect(positions.shellBottom).toBeLessThan(0)
  expect(positions.coreTop).toBeGreaterThan(positions.height)
  await page.locator('.onboarding-mark').evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true }))
      animation.currentTime = 800
  })
  await page.screenshot({
    path: 'artifacts/onboarding/assembling.png',
    animations: 'allow',
  })
  await page.locator('.onboarding-mark').evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true }))
      animation.currentTime = 1500
  })
  await expect(
    page.getByRole('heading', { name: 'Set up your password' }),
  ).toBeVisible()
  await expect(page.locator('.onboarding-fields')).toHaveCSS('opacity', '1')
  expect(await mark!.evaluate((element) => element.isConnected)).toBe(true)
  expect((await mark!.boundingBox())!.y).toBeLessThan(initialMark!.y - 80)
  await expect(page.locator('.onboarding-content')).toHaveCSS(
    'box-shadow',
    'none',
  )
  await page.getByLabel('Password', { exact: true }).fill('draft password')
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).press('Enter')
  await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', 'dark')
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('draft password')
  expect(
    await app?.evaluate((element) =>
      Boolean(element.closest('[inert], [aria-hidden="true"]')),
    ),
  ).toBe(true)
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab')
    expect(
      await page
        .locator('.onboarding-page')
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(true)
  }
  await page
    .getByLabel('Password', { exact: true })
    .fill('preview password only 9274!')
  await page
    .getByLabel('Confirm password', { exact: true })
    .fill('preview password only 9274!')
  await page.getByRole('button', { name: 'Create password' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents' })).toBeVisible()
  await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', 'dark')
  await page.getByRole('button', { name: 'Replay animation' }).click()
  await page.getByRole('button', { name: 'View sign in', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Sign in to your Suite' }),
  ).toBeVisible()
  await expect(
    page.getByLabel('Confirm password', { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await page
    .getByLabel('Password', { exact: true })
    .fill('any preview password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents' })).toBeVisible()
  await page.getByRole('button', { name: 'Replay animation' }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText(
    'Welcome to Aixand',
  )
  await expect(
    page.getByRole('heading', { name: 'Set up your password' }),
  ).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('heading', { name: 'Home', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Open onboarding preview', exact: true }),
  ).toBeFocused()
  expect(await app?.evaluate((element) => element.isConnected)).toBe(true)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(storage)
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'light')
  expect(mutations).toEqual([])
  await open(page)
  await expect(page.getByRole('button', { name: 'Switch to dark theme', exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Set up your password' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close onboarding preview' }).click()
  await expect(
    page.getByRole('button', { name: 'Open onboarding preview', exact: true }),
  ).toBeFocused()
})

test('agent onboarding opens a centered workspace while the existing mark moves into the top header', async ({ page }) => {
  await workspace(page)
  await open(page)
  await expect(page.locator('.onboarding-fields')).toHaveCSS('opacity', '1')
  const content = page.locator('.onboarding-content')
  const mark = await page.locator('.onboarding-mark').elementHandle()
  const passwordSize = await content.boundingBox()
  const start = await mark!.boundingBox()
  expect(passwordSize!.width).toBe(380)
  await page.getByLabel('Password', { exact: true }).fill('preview password only 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('preview password only 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  await expect(page.locator('.onboarding-stage')).toHaveAttribute('data-header-phase', 'moving')
  expect(await mark!.evaluate(element => element.isConnected)).toBe(true)
  await page.locator('.onboarding-mark').evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!
    animation.pause()
    animation.currentTime = 0
  })
  await expect(page.locator('.onboarding-content h1')).toHaveText('Set up your agents')
  await expect(page.locator('.onboarding-content h1')).toBeHidden()
  await expect(page.locator('.onboarding-fields')).toHaveAttribute('aria-hidden', 'true')
  await expect(page.locator('.onboarding-fields')).toHaveAttribute('inert', '')
  await page.keyboard.press('Tab')
  expect(await page.locator('.onboarding-fields').evaluate(element => element.contains(document.activeElement))).toBe(false)
  expect(Math.abs((await mark!.boundingBox())!.y - start!.y)).toBeLessThan(3)
  await page.locator('.onboarding-mark').evaluate(element => {
    element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!.currentTime = 350
  })
  const middle = await mark!.boundingBox()
  expect(middle!.y).toBeLessThan(start!.y - 40)
  await expect(page.locator('.onboarding-content h1')).toBeHidden()
  await expect(page.locator('.agent-setup')).toBeHidden()
  await page.screenshot({ path: 'artifacts/onboarding/expanding-setup.png', animations: 'allow' })
  await page.locator('.onboarding-mark').evaluate(element => {
    const animation = element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!
    animation.currentTime = 700
    animation.finish()
  })
  await expect(page.locator('.onboarding-stage')).toHaveAttribute('data-header-phase', 'ready')
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeFocused()
  await expect(page.locator('.onboarding-fields')).toHaveAttribute('aria-hidden', 'false')
  await expect(page.locator('.onboarding-fields')).not.toHaveAttribute('inert', '')
  await expect.poll(async () => (await content.boundingBox())!.width).toBe(1000)
  expect(Math.abs((await content.boundingBox())!.x - (1440 - 1000) / 2)).toBeLessThan(1)
  const setupHeading = await page.getByRole('heading', { name: 'Set up your agents', exact: true }).boundingBox()
  const setupMark = await mark!.boundingBox()
  expect(setupMark!.y + setupMark!.height).toBeLessThanOrEqual(setupHeading!.y)
  expect((await mark!.boundingBox())!.y).toBeLessThan(middle!.y)
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const workspaceSize = await page.locator('.setup-workspace-layout').boundingBox()
  const footerSize = await page.locator('.setup-workspace-footer').boundingBox()
  expect(workspaceSize!.width).toBe(1000)
  expect(workspaceSize!.height).toBeGreaterThanOrEqual(400)
  expect(Math.abs(footerSize!.width - workspaceSize!.width)).toBeLessThan(1)
  await page.locator('.onboarding-overlay').evaluate(element => element.scrollTo(0, 0))
  await page.screenshot({ path: 'artifacts/onboarding/full-page-installation.png', fullPage: true })
  await page.getByRole('button', { name: 'Replay animation' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your password', exact: true })).toBeVisible()
  await expect(content).toHaveCSS('width', '380px')
  await page.getByRole('button', { name: 'View sign in', exact: true }).click()
  expect((await content.boundingBox())!.width).toBe(380)
})

test('enabling reduced motion during the icon movement reveals setup immediately', async ({ page }) => {
  await workspace(page)
  await open(page)
  await expect(page.locator('.onboarding-fields')).toHaveCSS('opacity', '1')
  await page.getByLabel('Password', { exact: true }).fill('preview password only 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('preview password only 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  await page.locator('.onboarding-mark').evaluate(element => {
    element.getAnimations().find(animation => animation.id === 'aixand-setup-header')!.pause()
  })
  await expect(page.locator('.onboarding-content h1')).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  await expect(page.locator('.onboarding-fields')).toHaveAttribute('aria-hidden', 'false')
  expect(await page.locator('.onboarding-mark').evaluate(element => element.getAnimations().some(animation => animation.id === 'aixand-setup-header'))).toBe(false)
  await page.getByRole('button', { name: 'Replay animation' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your password', exact: true })).toBeVisible()
})

for (const mode of ['light', 'dark'] as const) {
  for (const width of [320, 390, 1440]) {
    test(`${mode} onboarding fits ${width}px and respects reduced motion`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 780 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await workspace(page, mode)
      await open(page)
      const dialog = page.getByRole('dialog', {
        name: 'Set up your password',
        exact: true,
      })
      await expect(dialog).toBeVisible({ timeout: 1000 })
      await expect(page.locator('.onboarding-fields')).toHaveCSS(
        'transition-duration',
        '0s',
      )
      await expect(page.locator('.onboarding-content')).toHaveCSS(
        'box-shadow',
        'none',
      )
      await expect(page.locator('.onboarding-overlay')).toHaveAttribute(
        'data-bbb-mode',
        mode,
      )
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
      await expect(
        dialog.getByRole('button', { name: 'Create password' }),
      ).toBeInViewport()
      await page.screenshot({
        path: `artifacts/onboarding/${mode}-${width}-setup.png`,
        fullPage: true,
      })
      await page.getByRole('button', { name: 'View sign in' }).click()
      await expect(
        page.getByRole('dialog', { name: 'Sign in to your Suite' }),
      ).toBeVisible()
      await page.screenshot({
        path: `artifacts/onboarding/${mode}-${width}-login.png`,
        fullPage: true,
      })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await page.getByRole('button', { name: 'View password setup' }).click()
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%'
      })
      await page
        .getByRole('button', { name: 'Create password' })
        .scrollIntoViewIfNeeded()
      await expect(
        page.getByRole('button', { name: 'Create password' }),
      ).toBeInViewport()
      expect(
        await page.evaluate(
          () =>
            document.querySelector('.onboarding-overlay')!.scrollWidth <=
            innerWidth,
        ),
      ).toBe(true)
      await page.keyboard.press('Escape')
      await expect(
        page.getByRole('button', { name: 'Open onboarding preview', exact: true }),
      ).toBeFocused()
    })
  }
}
