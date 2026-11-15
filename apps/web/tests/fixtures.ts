import { test as base, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function mockAuthentication(page: Page) {
  await page.route('**/api/capabilities', route => route.fulfill({ json: { voice: true } }))
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  await page.route('**/api/auth/installation/status', route =>
    route.fulfill({ json: { available: false, ready: true } }))
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'isolated-ui-csrf',
        expiresAt: Date.now() + 3600000,
      },
    })
  )
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { state: 'configured' } })
  )
}

export async function openChatSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  if (!await dialog.isVisible()) {
    await openChatModelSettings(page)
    await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  }
  return dialog
}

export async function openComposerNotices(page: Page, timeout = 5000) {
  const summary = page.locator('.command-composer-status-summary')
  await expect(summary).toBeVisible({ timeout })
  if (await summary.getAttribute('aria-expanded') === 'false') await summary.click()
  return page.locator('.command-composer-status-list')
}

export async function setChatMessageTiming(page: Page, mode: 'steer' | 'queue') {
  const dialog = await openChatSettings(page)
  await dialog.getByRole('button', { name: / Message timing$/ }).click()
  await page.getByRole('option', { name: mode === 'queue' ? 'Send after this turn' : /^(Add to current turn|Send now)/ }).click()
  await expect(dialog).not.toBeVisible()
}

export async function openChatModelSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Choose model', exact: true })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: / Model$/ }).click()
  return dialog
}

export async function setCustomChatModel(page: Page, model: string) {
  const dialog = await openChatModelSettings(page)
  const advanced = dialog.locator('.command-model-advanced')
  if (await advanced.getAttribute('open') === null) await advanced.locator('summary').click()
  await dialog.getByRole('button', { name: /^(Use a|Edit) custom model…$/ }).click()
  await dialog.getByRole('textbox', { name: 'Model ID', exact: true }).fill(model)
  await dialog.getByRole('button', { name: 'Use model', exact: true }).click()
  return dialog
}

export async function openAdvancedModelSettings(page: Page) {
  const dialog = await openChatModelSettings(page)
  const advanced = dialog.locator('.command-model-advanced')
  if (await advanced.getAttribute('open') === null) await advanced.locator('summary').click()
  return dialog
}

export async function openReasoningSettings(page: Page) {
  const picker = await openChatModelSettings(page)
  await picker.getByRole('option', { selected: true }).press('ArrowRight')
  const dialog = page.locator('.command-model-reasoning-panel')
  await expect(dialog).toBeVisible()
  return dialog
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    if (testInfo.project.metadata.mockAuthentication) await mockAuthentication(page)
    const screenshot = page.screenshot.bind(page)
    page.screenshot = (options = {}) => screenshot({ ...options,
      ...(options.path && process.env.SUITE_TEST_ARTIFACTS ? {
        path: join(process.env.SUITE_TEST_ARTIFACTS, 'screenshots', options.path),
      } : {}),
    })
    await use(page)
  },
  context: async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error('Browser tests require a baseURL')
    await context.addCookies([
      {
        name: 'aixand-dev-session',
        value: createHash('sha256')
          .update('isolated aixand browser session fixture')
          .digest('base64url'),
        url: baseURL,
        httpOnly: true,
        sameSite: 'Strict',
      },
    ])
    await use(context)
  },
})
export { expect }

export type { Page, WebSocketRoute, Locator } from '@playwright/test'
