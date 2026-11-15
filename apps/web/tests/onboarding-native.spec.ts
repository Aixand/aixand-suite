import { expect, test, type Page } from './fixtures'

async function openSetup(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
  await page.goto('/tests/onboarding-preview.html#/home')
  await page.getByRole('button', { name: 'Open onboarding preview', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('preview password only 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('preview password only 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
}

async function start(page: Page) {
  await page.getByRole('button', { name: /^Continue(?: with \d+ agents?)?$/ }).click()
}

async function signIn(page: Page, profile: string) {
  await page.getByLabel('Profile name', { exact: true }).fill(profile)
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Complete sign-in (preview)', exact: true }).click()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
}

test('beta onboarding offers only Codex and OpenCode', async ({ page }) => {
  await openSetup(page)
  await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'OpenCode', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Available agents' }).getByRole('checkbox')).toHaveCount(2)
  for (const name of ['Claude Code', 'Antigravity', 'GitHub Copilot', 'Gemini'])
    await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(0)
})

test('Codex creates a native profile before sign-in and requires explicit acceptance', async ({ page }) => {
  await openSetup(page)
  await start(page)
  await expect(page.getByLabel('Account name', { exact: true })).toHaveCount(0)
  await signIn(page, 'codex-work')
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
})

test('Codex offers browser and device-code sign-in during setup', async ({ page }) => {
  await openSetup(page)
  await start(page)
  await page.getByRole('button', { name: /Sign-in method/ }).click()
  await expect(page.getByRole('option', { name: 'Browser', exact: true })).toBeVisible()
  await page.getByRole('option', { name: 'Device code', exact: true }).click()
  await expect(page.getByText('Open the link shown in the sign-in terminal and enter the one-time code.', { exact: true })).toBeVisible()
  await signIn(page, 'device-work')
})

test('OpenCode installation completes before native profile sign-in', async ({ page }) => {
  await openSetup(page)
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await page.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Do you want to sign in to a provider?' })).toBeVisible()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign in to a provider', exact: true }).click()
  await signIn(page, 'opencode-work')
  await expect(page.getByText('OpenCode is ready', { exact: true })).toBeVisible()
})

test('OpenCode free models create a profile without a sign-in operation', async ({ page }) => {
  await openSetup(page)
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await start(page)
  await page.getByRole('button', { name: 'Install OpenCode', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  await page.getByRole('button', { name: 'Continue without signing in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create profile and sign in', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Change sign-in choice', exact: true }).click()
  await page.getByRole('button', { name: 'Continue without signing in', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('opencode-free')
  await page.getByRole('button', { name: 'Create profile without signing in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Complete sign-in (preview)', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('opencode-free')
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByText('OpenCode is ready', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
})

test('native sign-in failure remains retryable without duplicating the profile', async ({ page }) => {
  await openSetup(page)
  await start(page)
  await page.getByText('Preview controls', { exact: true }).click()
  await page.getByRole('button', { name: /Preview operation outcome/ }).click()
  await page.getByRole('option', { name: 'Failure', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('retry-work')
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('retry-work')
  await page.getByRole('button', { name: /Preview operation outcome/ }).click()
  await page.getByRole('option', { name: 'Success', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in to profile', exact: true }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)', exact: true }).click()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue to projects', exact: true })).toBeEnabled()
})
