import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  LIBRARY_BACKUP_KEY, LIBRARY_KEY, LEGACY_WORKFLOW_ID, SEQUENTIAL_WORKFLOW_ID,
} from '../src/workflows/library'
import { DRAFT_KEY, sequentialDraft } from '../src/workflows/builder/model'
import { compileSequence } from '../src/workflows/builder/compile'
import { RUN_KEY, runStorageKey } from '../src/workflows/builder/runStorage'
import { savedCanvas } from './workflow-helpers'

const list = (page: Page) => page.getByRole('list', { name: 'Workflows', exact: true })
async function createWorkflow(page: Page, name: string) {
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Workflow name').fill(name)
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: name.trim(), exact: true })).toBeVisible()
  return decodeURIComponent(new URL(page.url()).hash.slice('#/workflows/'.length))
}

test('a clean library contains the greeting, adviser, and audit examples and supports search', async ({ page }) => {
  await page.goto('/#/workflows')
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
  await expect(list(page).getByRole('listitem')).toHaveCount(3)
  await expect(list(page)).toContainText('Brain and Implementer')
  await expect(list(page)).toContainText('Architecture + security → tasks → Main inbox')
  await expect(list(page)).toContainText('7 steps')
  await expect(page.locator('.react-flow')).toHaveCount(0)
  await page.getByLabel('Search workflows').fill('HELLO')
  await expect(list(page).getByRole('listitem')).toHaveCount(1)
  await page.getByLabel('Search workflows').fill('missing')
  await expect(page.getByRole('heading', { name: 'No matching workflows' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(list(page).getByRole('listitem')).toHaveCount(3)
})

test('named empty workflows, edits, and renames remain independent after navigation and reload', async ({ page }) => {
  await page.goto('/#/workflows')
  const id = await createWorkflow(page, '  My workflow  ')
  expect(id).not.toBe(SEQUENTIAL_WORKFLOW_ID)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'A workflow starts with an idea' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'My workflow', exact: true })).toBeVisible()
  await page.getByRole('region', { name: 'Workflow canvas', exact: true })
    .click({ button: 'right', position: { x: 100, y: 100 } })
  await page.getByRole('menuitem', { name: 'Spawn agent', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Step name', { exact: true }).fill('My first step')
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await expect(list(page).getByRole('listitem')).toHaveCount(4)
  await expect(list(page)).toContainText('1 step')
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Workflow name', { exact: true }).fill('Original greeting')
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await page.reload()
  await expect(list(page).getByRole('listitem')).toHaveCount(4)
  await expect(page.getByRole('button', { name: 'Open Original greeting', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open My workflow', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.locator('.react-flow__node')).toContainText('My first step')
  expect((await savedCanvas(page, id)).name).toBe('My workflow')
  expect((await savedCanvas(page)).name).toBe('Original greeting')
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
})

test('creation validates names, cancels cleanly, and gives duplicate names different IDs', async ({ page }) => {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Create workflow' })).toBeDisabled()
  await dialog.getByLabel('Workflow name').fill('   ')
  await expect(dialog.getByRole('button', { name: 'Create workflow' })).toBeDisabled()
  await dialog.getByLabel('Workflow name').fill('Discarded')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(list(page).getByRole('listitem')).toHaveCount(3)
  const first = await createWorkflow(page, 'Same name')
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  const second = await createWorkflow(page, 'Same name')
  expect(first).not.toBe(second)
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await expect(list(page).getByRole('listitem')).toHaveCount(5)
})

test('an unreadable library is preserved and backed up before new workflows are saved', async ({ page }) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, 'unreadable-library')
  }, LIBRARY_KEY)
  await page.goto('/#/workflows')
  await expect(page.getByRole('status')).toContainText('saved workflow list could not be read')
  expect(await page.evaluate((key) => localStorage.getItem(key), LIBRARY_KEY)).toBe('unreadable-library')
  await createWorkflow(page, 'Recovery')
  expect(await page.evaluate((key) => localStorage.getItem(key), LIBRARY_BACKUP_KEY)).toBe('unreadable-library')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Recovery', exact: true })).toBeVisible()
})

test('failed storage writes keep creation open with an error and can be retried', async ({ page }) => {
  await page.addInitScript((key) => {
    const setItem = Storage.prototype.setItem
    Object.assign(window, { failWorkflowWrites: true })
    Storage.prototype.setItem = function (name, value) {
      if (name === key && (window as unknown as { failWorkflowWrites: boolean }).failWorkflowWrites)
        throw new DOMException('Storage unavailable', 'QuotaExceededError')
      setItem.call(this, name, value)
    }
  }, LIBRARY_KEY)
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Workflow name').fill('Retry me')
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Browser storage is unavailable')
  await expect(page).toHaveURL(/#\/workflows$/)
  await page.evaluate(() => Object.assign(window, { failWorkflowWrites: false }))
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Retry me', exact: true })).toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
})

test('legacy run recovery belongs to its migrated workflow when switching editors', async ({ page }) => {
  const draft = { ...sequentialDraft(), name: 'Saved greeting' }
  const snapshot = {
    ...compileSequence(draft), key: 'legacy-submission', jobId: 'legacy-job',
    labels: Object.fromEntries(draft.nodes.map((node) => [node.id, node.data.label])),
  }
  await page.addInitScript(({ draftKey, runKey, canvas, run }) => {
    if (!localStorage.getItem(draftKey)) localStorage.setItem(draftKey, canvas)
    if (!localStorage.getItem(runKey)) localStorage.setItem(runKey, run)
  }, { draftKey: DRAFT_KEY, runKey: RUN_KEY, canvas: JSON.stringify(draft), run: JSON.stringify(snapshot) })
  const calls: { op: string; args: { id?: string } }[] = []
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      calls.push(message)
      const result = message.op === 'health' ? { protocol: 1 }
        : { events: [], state: 'running', next_after: 0, has_more: false }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto(`/#/workflows/${LEGACY_WORKFLOW_ID}`)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect.poll(() => calls.some((call) => call.op === 'events' && call.args.id === 'legacy-job')).toBe(true)
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeEnabled()
  expect(await page.evaluate((key) => localStorage.getItem(key), runStorageKey(SEQUENTIAL_WORKFLOW_ID))).toBeNull()
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).jobId, runStorageKey(LEGACY_WORKFLOW_ID))).toBe('legacy-job')
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await page.getByRole('button', { name: 'Open Saved greeting', exact: true }).click()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeDisabled()
  await expect(page.getByText('Job: legacy-job', { exact: true })).toBeVisible()
  expect(calls.filter((call) => call.op === 'submit')).toHaveLength(0)
  // Clearing the migrated record must not bring back the old global run on reload.
  await page.evaluate((key) => localStorage.removeItem(key), runStorageKey(LEGACY_WORKFLOW_ID))
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Job: legacy-job', { exact: true })).toHaveCount(0)
  expect(await page.evaluate((key) => localStorage.getItem(key), runStorageKey(LEGACY_WORKFLOW_ID))).toBeNull()
})

test('missing workflow links return to the list and the list and creation dialog are accessible', async ({ page }) => {
  await page.goto('/#/workflows/missing')
  await expect(page.getByRole('heading', { name: 'Workflow not found' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  for (const mode of ['light', 'dark']) {
    await page.evaluate((mode) => localStorage.setItem('aixand.appearance', mode), mode)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'New workflow', exact: true }).click()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'New workflow', exact: true })).toBeFocused()
  }
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.getByRole('main').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})
