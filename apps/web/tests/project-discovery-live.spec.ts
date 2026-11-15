import { openChatSettings, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('discover-and-add uses the real registry, skips dependencies and survives reload without duplicates', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'suite-browser-discovery-'))
  try {
    for (const name of ['Discovery web', 'Discovery api', 'Discovery web/member', 'node_modules/dependency']) {
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(join(root, name, 'package.json'), '{}')
    }
    await page.goto('/#/chat')
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled()
    await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my project discovery draft')
    async function scan() {
      await page.getByRole('button', { name: 'New project', exact: true }).click()
      await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
      await dialog.getByLabel('Starting directory').fill(root)
      await dialog.getByRole('button', { name: 'Discover and add', exact: true }).click()
      await expect(dialog.getByLabel('Starting directory')).toHaveCount(0)
      await expect(dialog.getByRole('status')).toHaveText('Completed')
      return dialog
    }
    let dialog = await scan()
    await expect(dialog.getByText('Added 2 projects · 0 already registered', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Nested package · package.json', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'dependency', exact: true })).toHaveCount(0)
    await dialog.getByRole('checkbox', { name: 'Show project roots only', exact: true }).focus()
    await page.keyboard.press('Space')
    await expect(dialog).toContainText('Showing 2 project roots · 1 hidden')
    await expect(dialog.getByRole('checkbox', { name: 'member', exact: true })).toHaveCount(0)
    await dialog.getByLabel('Filter by name or path').fill('Discovery web')
    await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click()
    await expect(dialog).toContainText('Showing 1 project root matching “Discovery web” · 2 hidden')
    await expect(dialog.getByRole('checkbox', { name: 'Discovery api', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep my project discovery draft')
    await page.reload()
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
    const savedCard = dialog.getByRole('article', { name: `Discovery under ${root}`, exact: true })
    await expect(savedCard).toContainText('Showing 1 project root matching “Discovery web” · 2 hidden')
    await expect(savedCard.getByRole('list', { name: 'Matching projects' })).toContainText('Discovery web')
    await savedCard.getByRole('button', { name: 'View discovery', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: 'Show project roots only', exact: true })).toBeChecked()
    await expect(dialog.getByLabel('Filter by name or path')).toHaveValue('Discovery web')
    await expect(dialog.getByRole('checkbox', { name: 'member', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(dialog.getByRole('checkbox', { name: 'member', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
    dialog = await scan()
    await expect(dialog.getByText('Added 0 projects · 2 already registered', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
    await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
    await expect(page.getByRole('option', { name: /^Discovery web/ })).toHaveCount(1)
    await expect(page.getByRole('option', { name: /^Discovery api/ })).toHaveCount(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit Suite root is discovered above its five components in the same results card', async ({ page }) => {
  const collection = mkdtempSync(join(tmpdir(), 'suite-browser-root-'))
  const root = join(collection, 'aixand-suite')
  const members = ['aixand-ir', 'aixand-python', 'aixand-server', 'aixand-vox', 'aixand-web']
  try {
    mkdirSync(join(root, '.aixand'), { recursive: true })
    writeFileSync(join(root, '.aixand/project.json'), JSON.stringify({ schema: 'aixand/project-1', name: 'aixand-suite', members }))
    for (const name of members) {
      mkdirSync(join(root, name, '.git'), { recursive: true })
      writeFileSync(join(root, name, 'package.json'), '{}')
    }
    await page.goto('/#/chat')
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
    await dialog.getByLabel('Starting directory').fill(collection)
    await dialog.getByRole('button', { name: 'Discover and add', exact: true }).click()
    await expect(dialog.getByLabel('Starting directory')).toHaveCount(0)
    await expect(dialog.getByRole('status')).toHaveText('Completed')
    await expect(dialog.getByText('Added 1 project · 0 already registered', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'aixand-suite', exact: true })).toBeVisible()
    await expect(dialog.getByRole('checkbox', { name: 'aixand-web', exact: true })).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Show project roots only', exact: true }).focus()
    await page.keyboard.press('Space')
    await expect(dialog).toContainText('Showing 1 project root · 5 hidden')
    for (const name of members) await expect(dialog.getByRole('checkbox', { name, exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
    const card = dialog.getByRole('article', { name: `Discovery under ${collection}`, exact: true })
    await expect(card).toContainText('Showing 1 project root · 5 hidden')
    await expect(card.getByRole('list', { name: 'Matching projects' })).toContainText('aixand-suite')
    await card.getByRole('button', { name: 'View discovery', exact: true }).click()
    await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click()
    for (const name of members) await expect(dialog.getByRole('checkbox', { name, exact: true })).toBeVisible()
  } finally {
    rmSync(collection, { recursive: true, force: true })
  }
})
