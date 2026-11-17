// Run from Suite root while Web's Vite server is listening on 127.0.0.1:5347.
// npm --prefix apps/web run dev -- --host 127.0.0.1 --port 5347 --strictPort
// node scripts/docs/capture-onboarding.mjs
// Uses the real UI's fixture. Never installs providers or contacts native accounts.
import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(path.join(root, 'apps/web/package.json'))
const { chromium, expect } = require('@playwright/test')
const output = path.join(root, 'docs/assets/screenshots/onboarding')
const browser = await chromium.launch()
const captures = []
try {
  await mkdir(output, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' })
  // Reject real API traffic; all authentication and provider state is disposable.
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    const values = {
      '/api/capabilities': { voice: false, vox: false },
      '/api/auth/onboarding/status': { needed: false },
      '/api/auth/installation/status': { available: false, ready: true },
      '/api/auth/session': { authenticated: true, csrfToken: 'documentation-fixture', expiresAt: 4102444800000 },
      '/api/auth/status': { state: 'configured' },
    }
    return route.fulfill({ status: url.pathname in values ? 200 : 503, json: values[url.pathname] ?? { error: 'Documentation capture blocks live API calls' } })
  })
  await page.routeWebSocket(/\/api\//, socket => socket.close())
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'light'))
  async function open() {
    await page.goto('about:blank')
    await page.goto('http://127.0.0.1:5347/tests/onboarding-preview.html#/home')
    await page.getByRole('button', { name: 'Open onboarding preview', exact: true }).click()
    await page.getByLabel('Password', { exact: true }).fill('documentation preview only 9274!')
    await page.getByLabel('Confirm password', { exact: true }).fill('documentation preview only 9274!')
    await page.getByRole('button', { name: 'Create password', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).toBeVisible()
  }
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.onboarding-overlay').screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' })
    captures.push(name + '.png')
  }
  await open()
  await capture('choose-providers')
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'OpenCode', exact: true }).press('Space')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Install OpenCode', exact: true })).toBeVisible()
  await capture('install-provider')

  await open()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('work')
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).scrollIntoViewIfNeeded()
  await capture('profile-sign-in')
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Complete sign-in (preview)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use this profile', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Use this profile', exact: true }).scrollIntoViewIfNeeded()
  await capture('confirm-profile')
  await page.getByRole('button', { name: 'Use this profile', exact: true }).click()
  await page.getByRole('button', { name: 'Continue to projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your projects', exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Include website', exact: true }).press('Space')
  await expect(page.getByRole('button', { name: 'Finish setup', exact: true })).toBeEnabled()
  await capture('add-projects')
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
  await expect(page.locator('.onboarding-overlay')).toHaveCount(0)

  const sources = ['apps/web/src/auth/AgentOnboarding.tsx', 'apps/web/src/auth/AgentSetupWorkspace.tsx', 'apps/web/src/auth/AgentAccounts.tsx', 'apps/web/src/auth/ProjectOnboardingPreview.tsx', 'apps/web/tests/support/OnboardingPreview.tsx']
  const sourceHashes = {}
  for (const name of sources) sourceHashes[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')
  await writeFile(path.join(output, 'capture.json'), JSON.stringify({ schema: 1, mode: 'real-ui-with-fixture-data', viewport: { width: 1280, height: 1100 }, theme: 'light', command: 'node scripts/docs/capture-onboarding.mjs', screenshots: captures, sourceHashes }, null, 2) + '\n')
  console.log(`Captured ${captures.length} onboarding screenshots with fixture data; no provider login performed.`)
} finally {
  await browser.close()
}
