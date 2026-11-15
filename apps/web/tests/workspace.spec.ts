import { expect, test } from './fixtures'

test('Carrier opens without sample messages and supports an offline draft', async ({ page }) => {
  await page.goto('/#/carrier')
  await expect(page.locator('.topbar')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Carrier', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Carrier', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Workspace access key')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Navigation review is ready/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.getByRole('form', { name: 'New message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
})

test('new agent profiles are available in Chat', async ({ page }) => {
  await page.goto('/#/agents')
  await expect(page.getByRole('button', { name: 'New profile' })).toBeEnabled()
  await page.getByRole('button', { name: 'New profile' }).click()
  await page.getByLabel('Profile name').fill('Designer')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(
    page.getByRole('heading', { name: 'Designer', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Chat', exact: true })
    .click()
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page
    .getByRole('option', { name: /^Designer.*Codex profile$/ })
    .click()
  await expect(page.getByRole('button', { name: /Designer.*Profile$/ })).toBeVisible()
})
