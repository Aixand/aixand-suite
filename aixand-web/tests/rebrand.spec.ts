import { expect, test } from './fixtures'

test('migrates legacy appearance and preserves newer preferences', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('intessio.appearance', 'dark')
  })
  await page.goto('/')
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'dark')
  expect(await page.evaluate(() => localStorage.getItem('aixand.appearance'))).toBe('dark')
  await page.evaluate(() => localStorage.setItem('aixand.appearance', 'light'))
  await page.reload()
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'light')
  expect(await page.evaluate(() => localStorage.getItem('intessio.appearance'))).toBe('dark')
})

test('copies legacy draft storage without modifying workflow content', async ({ page }) => {
  await page.goto('/')
  const draft = JSON.stringify({ name: 'My intessio workflow', body: { steps: [] } })
  const saved = await page.evaluate(async (value) => {
    const { readStorage } = await import('/src/storage.ts')
    localStorage.setItem('intessio.ir.workflow.v0.1', value)
    return readStorage('aixand.ir.workflow.v0.1')
  }, draft)
  expect(saved).toBe(draft)
  expect(await page.evaluate(() => localStorage.getItem('intessio.ir.workflow.v0.1'))).toBe(draft)
})
