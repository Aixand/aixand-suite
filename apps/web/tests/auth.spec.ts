import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const password = 'isolated Suite password 9274!'
async function dismissSetup(page: Page) {
  await expect(page.getByRole('heading', { name: 'Set up your agents' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up later', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: 'Continue setup' })).toBeVisible()
}
test.describe.serial('Password onboarding and browser sessions', () => {
  test('creates a password on first startup and continues directly to agent setup', async ({
    page,
  }) => {
    await page.goto('/#/workflows')
    await expect(
      page.getByRole('heading', { name: 'Set up your password' }),
    ).toBeVisible()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    await expect(page.getByLabel('Setup secret', { exact: true })).toHaveCount(
      0,
    )
    await expect(
      page.getByRole('button', { name: 'Forgot password?' }),
    ).toHaveCount(0)
    await page.screenshot({
      path: 'artifacts/password-setup.png',
      fullPage: true,
      animations: 'disabled',
    })
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page
      .getByLabel('Confirm password', { exact: true })
      .fill('different confirmation')
    await page.getByRole('button', { name: 'Create password' }).click()
    await expect(page.getByRole('alert')).toContainText('Passwords must match')
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.getByLabel('Confirm password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Create password' }).click()
    await expect(page).toHaveURL(/#\/agents\/providers$/)
    await expect(page.getByRole('heading', { name: 'Set up your agents' })).toBeVisible()
    await page.getByRole('button', { name: /^Suite host ·/ }).click()
    await expect(page.getByRole('dialog', { name: 'Installation target', exact: true })).toContainText('Suite host')
    await page.keyboard.press('Escape')
    await page.reload()
    await dismissSetup(page)
    await expect(
      page.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('Workspace access key')).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Sign in to your Suite' }),
    ).toHaveCount(0)
    const cookies = await page.context().cookies()
    expect(
      cookies.find((cookie) => cookie.name === 'aixand-dev-session'),
    ).toMatchObject({ httpOnly: true, sameSite: 'Strict' })
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      'aixand-dev-session',
    )
    const local = await page.evaluate(() => Object.keys(localStorage))
    expect(local.some((key) => /password|auth|session-token/.test(key))).toBe(
      false,
    )
    await page
      .getByRole('button', { name: 'Profile menu', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Sign in to your Suite' }),
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Sign in to your Suite' }),
    ).toBeVisible()
  })
  test('rejects a wrong password and provides both recovery instruction formats', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByLabel('Password', { exact: true }).fill('incorrect')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Invalid password')
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(
      page.getByRole('heading', { name: 'Recover your password' }),
    ).toBeVisible()
    await expect(
      page.getByText('npm run auth:recover', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'AI agent instructions' }).click()
    await expect(page.locator('.auth-prompt')).toContainText(
      'Do not delete authentication records',
    )
    await expect(
      page.getByRole('button', { name: 'Copy instructions' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({
      path: 'artifacts/password-login.png',
      fullPage: true,
    })
  })
  test('reflects logout across tabs and restores the bookmarked page after login', async ({
    page,
    context,
  }) => {
    await page.goto('/#/workflows')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await dismissSetup(page)
    await expect(
      page.getByRole('heading', { name: 'Workflows', exact: true }),
    ).toBeVisible()
    const other = await context.newPage()
    await other.goto('/#/agents/providers')
    await dismissSetup(other)
    await expect(
      other.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Profile menu', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await expect(
      other.getByRole('heading', { name: 'Sign in to your Suite' }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(other.getByRole('navigation')).toHaveCount(0)
    await other.close()
  })
  test('the profile menu links to Settings without changing the password or authenticated session', async ({
    page,
  }) => {
    await page.goto('/#/agents/providers')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await dismissSetup(page)
    await expect(
      page.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible()
    const url = page.url()
    const cookies = await page.context().cookies()
    const mutations: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/auth\//.test(request.url()))
        mutations.push(request.url())
    })
    await page
      .getByRole('button', { name: 'Profile menu', exact: true })
      .click()
    await expect(page.getByRole('menuitem')).toHaveText(['Settings', 'Recover a chat', 'Sign out'])
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: 'Workspace setup', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Set up workspace', exact: true })).toBeVisible()
    expect(mutations).toEqual([])
    expect(await page.context().cookies()).toEqual(cookies)
    expect((await page.request.get('/api/auth/session')).status()).toBe(200)
    expect(await (await page.request.get('/api/auth/status')).json()).toEqual({
      state: 'configured',
    })
    await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible()
    expect(page.url()).toBe(url)
    await page
      .getByRole('button', { name: 'Profile menu', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await dismissSetup(page)
    await expect(
      page.getByRole('heading', { name: 'Providers', exact: true }),
    ).toBeVisible()
  })
})
