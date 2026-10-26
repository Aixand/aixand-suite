import { test as base, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function mockAuthentication(page: Page) {
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
  if (!await dialog.isVisible()) await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  return dialog
}

export async function openChatModelSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Model settings', exact: true })
  if (!await dialog.isVisible()) await page.getByRole('button', { name: / Model$/ }).click()
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
