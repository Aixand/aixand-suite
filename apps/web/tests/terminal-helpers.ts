import { expect, type Page } from './fixtures'

export async function expandTerminalSection(page: Page, name = 'Others') {
  const heading = page.getByRole('button', { name, exact: true })
  await expect(heading).toBeVisible()
  if (await heading.getAttribute('aria-expanded') === 'false') await heading.click()
}

export async function openTerminalGroups(page: Page) {
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Manage groups', exact: true }).click()
}
