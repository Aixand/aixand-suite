import { authenticateTestPage } from '../scripts/isolated-test-server.mjs'
import { readFile } from 'node:fs/promises'
import { expect, mockAuthentication, test } from './fixtures'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  PREVIOUS_DRAFT_KEY,
  sequentialDraft,
} from '../src/workflows/builder/model'
import { LIBRARY_KEY, LEGACY_WORKFLOW_ID } from '../src/workflows/library'
import { savedCanvas, savedCanvasSource } from './workflow-helpers'

const key = 'aixand.workflow.canvas.v1'
const step = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"]`)
async function openBuilder(page: Page) {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Sequential hello', exact: true }),
  ).toBeVisible()
  await expect(step(page, 'send-x')).toBeVisible()
}
async function addNode(page: Page, name: string, settings = true) {
  await page
    .getByRole('region', { name: 'Workflow canvas', exact: true })
    .click({ button: 'right', position: { x: 100, y: 100 } })
  await page.getByRole('menuitem', { name, exact: true }).click()
  if (settings)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
}
async function connect(page: Page, source: string, target: string) {
  // Playwright waits for the handle to stop moving after the zoom animation.
  await page.locator(source).hover()
  const from = await page.locator(source).boundingBox()
  const to = await page.locator(target).boundingBox()
  expect(from).not.toBeNull()
  expect(to).not.toBeNull()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, {
    steps: 12,
  })
  await page.mouse.up()
}

test('storage error notices dismiss without marking an unsaved workflow as saved', async ({ page }) => {
  await page.addInitScript(storageKey => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === storageKey && (window as unknown as { failWorkflowWrites?: boolean }).failWorkflowWrites)
        throw new DOMException('Storage unavailable', 'QuotaExceededError')
      setItem.call(this, key, value)
    }
  }, LIBRARY_KEY)
  await openBuilder(page)
  await page.evaluate(() => Object.assign(window, { failWorkflowWrites: true }))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const name = page.getByRole('textbox', { name: 'Workflow name', exact: true })
  await name.fill('Unsaved workflow')
  const notice = page.locator('.wb-notice')
  await expect(notice).toContainText('Browser storage is unavailable')
  await notice.getByRole('button', { name: 'Dismiss notice', exact: true }).click()
  await expect(notice).not.toBeVisible()
  await expect(page.getByText('Not saved', { exact: true })).toBeVisible()
  await page.evaluate(() => Object.assign(window, { failWorkflowWrites: false }))
  await name.fill('Saved workflow')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
})

test('navigation opens the workflow list, then the sequential workflow without calling the workflow backend', async ({
  page,
}) => {
  const backendCalls: string[] = []
  page.on('request', (request) => {
    if (/\/api\/(workflows|runner)/.test(request.url()))
      backendCalls.push(request.url())
  })
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Workflows', exact: true })
    .click()
  await expect(page).toHaveTitle('Aixand · Workflows')
  await expect(page.getByRole('list', { name: 'Workflows', exact: true }).getByRole('listitem')).toHaveCount(3)
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await expect(page.locator('.react-flow__edge')).toHaveCount(6)
  await expect(page.getByRole('button', { name: 'Run workflow' })).toBeEnabled()
  await page.getByRole('button', { name: 'Check connections' }).click()
  await expect(
    page.getByText('All steps are connected', { exact: true }),
  ).toBeVisible()
  expect(backendCalls).toEqual([])
})

test('saved legacy canvases are replaced by the sequential workflow and supported agent and Carrier nodes are offered', async ({
  page,
}) => {
  const legacy = JSON.parse(JSON.stringify(sequentialDraft()))
  legacy.name = 'Research & review'
  legacy.nodes[0].data.kind = 'legacy-input'
  const previous = JSON.stringify(legacy)
  await page.addInitScript(
    ({ key, previous }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, previous)
    },
    { key, previous },
  )
  await openBuilder(page)
  const saved = {
    workflow: await savedCanvas(page),
    previous: await page.evaluate((backup) => localStorage.getItem(backup), PREVIOUS_DRAFT_KEY),
  }
  expect(saved.workflow.name).toBe('Sequential hello')
  expect(
    saved.workflow.nodes.map(
      (node: { data: { kind: string } }) => node.data.kind,
    ),
  ).toEqual(['spawn', 'send', 'wait', 'spawn', 'send', 'wait', 'done'])
  expect(saved.previous).toBe(previous)
  await expect(page.getByText('Draft', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Sample draft', { exact: true })).toHaveCount(0)
  await page
    .getByRole('region', { name: 'Workflow canvas', exact: true })
    .click({ button: 'right', position: { x: 40, y: 40 } })
  await expect(page.getByRole('menuitem')).toHaveCount(16)
  for (const name of [
    'Spawn agent',
    'Send instruction',
    'Wait for agent',
    'Done',
    'Open inbox',
    'Send Carrier message',
    'Wait for Carrier reply',
    'Acknowledge reply',
  ])
    await expect(
      page.getByRole('menuitem', { name, exact: true }),
    ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'More workflow actions' }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(1)
  await expect(
    page.getByRole('menuitem', {
      name: 'Reset to Sequential hello',
      exact: true,
    }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(step(page, 'spawn-x')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
})

test('saved sequential workflows migrate Done while retaining instructions and agent settings', async ({
  page,
}) => {
  const previous = JSON.parse(JSON.stringify(sequentialDraft()))
  previous.name = 'My saved greeting'
  previous.nodes[0].data.profile = 'aixand'
  previous.nodes[0].position.x = 70
  previous.nodes[1].data.prompt = 'Say hello again.'
  previous.nodes[6].data.kind = 'output'
  previous.nodes[6].data.expression = ''
  await page.addInitScript(
    ({ key, source }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, source)
    },
    { key, source: JSON.stringify(previous) },
  )
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Open My saved greeting', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'My saved greeting', exact: true }),
  ).toBeVisible()
  const saved = await savedCanvas(page, LEGACY_WORKFLOW_ID)
  expect(saved.nodes[0].data.profile).toBe('aixand')
  expect(saved.nodes[0].position.x).toBe(70)
  expect(saved.nodes[1].data.prompt).toBe('Say hello again.')
  expect(saved.nodes[6].data.kind).toBe('done')
  expect(saved.nodes[6].data).not.toHaveProperty('expression')
  await step(page, 'done').click()
  await expect(
    page.getByLabel('Result reference', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText(
      'The workflow finishes after all instructions complete and its agent sessions close. Carrier workflows also return the final reply.',
      { exact: true },
    ),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'My saved greeting', exact: true }),
  ).toBeVisible()
})

test('a compact single toolbar keeps the title and actions, and right-click adds a node at the cursor', async ({
  page,
}) => {
  await openBuilder(page)
  await expect(page.locator('.wb-header')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Add step', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('complementary', { name: 'Step library' }),
  ).toHaveCount(0)
  const toolbar = (await page.locator('.wb-toolbar').boundingBox())!
  expect(toolbar.height).toBeLessThanOrEqual(52)
  const title = (await page
    .getByRole('heading', { name: 'Sequential hello', exact: true })
    .boundingBox())!
  const actions = (await page
    .getByRole('group', { name: 'Workflow actions' })
    .boundingBox())!
  expect(
    Math.abs(title.y + title.height / 2 - actions.y - actions.height / 2),
  ).toBeLessThan(2)
  await page.getByRole('button', { name: 'Zoom In', exact: true }).click()
  const canvas = (await page
    .getByRole('region', { name: 'Workflow canvas', exact: true })
    .boundingBox())!
  await page
    .getByRole('region', { name: 'Workflow canvas', exact: true })
    .click({ button: 'right', position: { x: 180, y: 170 } })
  await page.getByRole('menuitem', { name: 'Spawn agent', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  const added = (await page
    .locator('.react-flow__node.selected')
    .boundingBox())!
  // Placement follows the cursor, rounded to the canvas grid.
  expect(Math.abs(added.x - canvas.x - 180)).toBeLessThanOrEqual(5)
  expect(Math.abs(added.y - canvas.y - 170)).toBeLessThanOrEqual(5)
  await expect(
    page.getByRole('menu', { name: 'Add workflow node' }),
  ).toHaveCount(0)
  const id = await page
    .locator('.react-flow__node.selected')
    .getAttribute('data-id')
  await connect(
    page,
    `[data-id="${id}"] [data-handleid="out"]`,
    '[data-id="spawn-x"] [data-handleid="in"]',
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
})

test('the node menu stays inside the canvas and supports keyboard navigation and dismissal', async ({
  page,
}) => {
  await openBuilder(page)
  const canvas = page.getByRole('region', {
    name: 'Workflow canvas',
    exact: true,
  })
  const bounds = (await canvas.boundingBox())!
  await canvas.click({
    button: 'right',
    position: { x: bounds.width - 8, y: bounds.height - 140 },
  })
  const menu = (await page.locator('.wb-context-menu').boundingBox())!
  expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  expect(menu.y + menu.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('menu', { name: 'Add workflow node' }),
  ).toHaveCount(0)
  await expect(canvas).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(
    page.getByRole('menuitem', { name: 'Project chat', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Agent tool', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await canvas.click({ button: 'right', position: { x: 30, y: 30 } })
  await page
    .getByRole('heading', { name: 'Sequential hello', exact: true })
    .click()
  await expect(
    page.getByRole('menu', { name: 'Add workflow node' }),
  ).toHaveCount(0)
})

test('long-press opens the node menu on touch screens and releasing keeps it open', async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  })
  const page = await context.newPage()
  if (testInfo.project.metadata.mockAuthentication) await mockAuthentication(page)
  await authenticateTestPage(page, baseURL!)
  try {
    await openBuilder(page)
    const canvas = (await page
      .getByRole('region', { name: 'Workflow canvas', exact: true })
      .boundingBox())!
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: canvas.x + 30, y: canvas.y + 100 }],
    })
    await expect(
      page.getByRole('menu', { name: 'Add workflow node' }),
    ).toBeVisible()
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
    await page.getByRole('menuitem', { name: 'Spawn agent', exact: true }).tap()
    await expect(page.locator('.react-flow__node')).toHaveCount(8)
  } finally {
    await context.close()
  }
})

test('step and workflow settings persist independently of executable IR', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('aixand.ir.workflow.v0.1', 'existing-ir-draft'),
  )
  await openBuilder(page)
  await step(page, 'send-x').click()
  await page.getByLabel('Step name', { exact: true }).fill('Greet the user')
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Say hello to the user.')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByLabel('Workflow name', { exact: true })
    .fill('My greeting workflow')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'My greeting workflow', exact: true }),
  ).toBeVisible()
  await expect(step(page, 'send-x')).toContainText('Greet the user')
  await step(page, 'send-x').click()
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(
    'Say hello to the user.',
  )
  expect(
    await page.evaluate(() => localStorage.getItem('aixand.ir.workflow.v0.1')),
  ).toBe('existing-ir-draft')
})

test('steps can be added, duplicated, deleted and restored with undo and redo', async ({
  page,
}) => {
  await openBuilder(page)
  await addNode(page, 'Spawn agent')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await page.getByLabel('Step name', { exact: true }).fill('New agent')
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(9)
  await expect(page.getByLabel('Step name', { exact: true })).toHaveValue(
    'New agent copy',
  )
  await page.getByRole('button', { name: 'Delete step', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(9)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
})

test('builder loads and creates unique node and connection IDs without randomUUID', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    })
  })
  await openBuilder(page)
  await addNode(page, 'Spawn agent')
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(9)
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('option', { name: 'Spawn agent X', exact: true }).click()
  await page.getByRole('button', { name: 'Connect step', exact: true }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  const draft = await savedCanvas(page)
  const newIds: string[] = [
    draft.nodes[7].id,
    draft.nodes[8].id,
    draft.edges[6].id,
  ]
  expect(new Set(newIds).size).toBe(3)
  for (const id of newIds)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  await page.reload()
  await expect(page.locator('.react-flow__node')).toHaveCount(9)
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  expect(errors).toEqual([])
})

test('connections allow branches and joins, reject cycles and duplicates, and validate session prerequisites', async ({ page }) => {
  await openBuilder(page)
  await connect(page, '[data-id="spawn-x"] [data-handleid="out"]', '[data-id="wait-x"] [data-handleid="in"]')
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  for (const [source, target] of [['spawn-x', 'send-x'], ['wait-y', 'send-x']]) {
    await connect(page, `[data-id="${source}"] [data-handleid="out"]`, `[data-id="${target}"] [data-handleid="in"]`)
    await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  }
  await step(page, 'send-x').click()
  await page.getByRole('button', { name: 'Delete step', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  await expect(page.locator('.react-flow__edge')).toHaveCount(5)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Wait for X: send an instruction before waiting.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeDisabled()
})

test('new workflow opens a separate named empty canvas and keeps the previous workflow', async ({
  page,
}) => {
  await openBuilder(page)
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Workflow name').fill('New idea')
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New idea', exact: true })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'A workflow starts with an idea' }),
  ).toBeVisible()
  await addNode(page, 'Spawn agent', false)
  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await page.getByRole('button', { name: 'Check connections' }).click()
  await expect(
    page.getByText('Finish a path with Result, Done, or Main inbox.'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to workflows', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Workflows', exact: true }).getByRole('listitem')).toHaveCount(4)
  await page.getByRole('button', { name: 'Open Sequential hello', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
})

test('canvas export round trips, and cyclic or malformed imports preserve the current workflow', async ({
  page,
}) => {
  await openBuilder(page)
  const downloadPromise = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Export workflow', exact: true })
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('Sequential-hello.canvas.json')
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(exported.format).toBe('aixand.workflow-canvas')
  expect(exported.nodes).toHaveLength(7)
  expect(exported.nodes[0]).not.toHaveProperty('measured')
  const file = page.getByLabel('Import canvas workflow', { exact: true })
  exported.name = 'Imported design'
  await file.setInputFiles({
    name: 'draft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  })
  await expect(
    page.getByRole('heading', { name: 'Imported design', exact: true }),
  ).toBeVisible()
  const saved = await savedCanvasSource(page)
  const cyclic = {
    ...exported,
    nodes: exported.nodes.filter((node: { id: string }) => node.id !== 'done'),
    edges: exported.edges.filter(
      (edge: { target: string }) => edge.target !== 'done',
    ),
  }
  cyclic.edges.push({
    id: 'cycle',
    source: 'wait-y',
    target: 'spawn-x',
    sourceHandle: 'out',
    targetHandle: 'in',
  })
  await file.setInputFiles({
    name: 'cycle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(cyclic)),
  })
  await expect(page.getByRole('status')).toContainText(
    'Invalid connection: check ports, duplicate links, and dependency cycles.',
  )
  await expect(page.locator('.react-flow__edge')).toHaveCount(6)
  exported.nodes[0].data.kind = 'condition'
  await file.setInputFiles({
    name: 'unsupported.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  })
  await expect(page.getByRole('status')).toContainText(
    'Only agent, Carrier messaging, and Done nodes are supported.',
  )
  expect(await savedCanvasSource(page)).toBe(
    saved,
  )
  await file.setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{bad json'),
  })
  await expect(
    page.getByRole('heading', { name: 'Imported design', exact: true }),
  ).toBeVisible()
  expect(await savedCanvasSource(page)).toBe(
    saved,
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Sequential hello', exact: true }),
  ).toBeVisible()
})

test('node positions survive dragging and reload', async ({ page }) => {
  await openBuilder(page)
  const before = await step(page, 'send-x').boundingBox()
  await page.mouse.move(
    before!.x + before!.width / 2,
    before!.y + before!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    before!.x + before!.width / 2 + 70,
    before!.y + before!.height / 2,
    { steps: 10 },
  )
  await page.mouse.up()
  await expect
    .poll(async () => (await savedCanvas(page)).nodes.find((node) => node.id === 'send-x')?.position.x)
    .not.toBe(0)
  const saved = await savedCanvasSource(page)
  await page.reload()
  await expect(step(page, 'send-x')).toBeVisible()
  expect(await savedCanvasSource(page)).toBe(
    saved,
  )
})

test('settings offer a keyboard connection path and graph changes support keyboard undo', async ({
  page,
}) => {
  await openBuilder(page)
  await addNode(page, 'Spawn agent')
  const added = page.locator('.react-flow__node.selected')
  await page.getByRole('button', { name: 'Next step' }).click()
  await page.getByRole('option', { name: 'Spawn agent X', exact: true }).click()
  await page.getByRole('button', { name: 'Connect step', exact: true }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  await added.focus()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(6)
  await added.focus()
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
  await added.focus()
  await page.keyboard.press('Delete')
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await expect(page.locator('.react-flow__edge')).toHaveCount(7)
})

test('an unreadable saved draft is preserved while recovered edits save to the library', async ({
  page,
}) => {
  await page.addInitScript(
    (key) => localStorage.setItem(key, 'unreadable-draft'),
    key,
  )
  await openBuilder(page)
  await expect(
    page.getByRole('heading', { name: 'Sequential hello', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toContainText(
    'Your saved workflow could not be read',
  )
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    'unreadable-draft',
  )
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByLabel('Workflow name', { exact: true })
    .fill('Recovered draft')
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  expect((await savedCanvas(page)).name).toBe('Recovered draft')
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe('unreadable-draft')
})

test('builder and selected step pass accessibility checks in light and dark modes', async ({
  page,
}) => {
  for (const mode of ['light', 'dark']) {
    await page.addInitScript(
      (mode) => localStorage.setItem('aixand.appearance', mode),
      mode,
    )
    await openBuilder(page)
    for (const selected of [false, true]) {
      if (selected) await step(page, 'send-x').click()
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      expect(results.violations, `${mode}, selected: ${selected}`).toEqual([])
    }
    await page.getByRole('button', { name: 'Close settings' }).click()
    await page
      .getByRole('region', { name: 'Workflow canvas', exact: true })
      .click({ button: 'right', position: { x: 40, y: 40 } })
    const menuResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(menuResults.violations, `${mode}, node menu`).toEqual([])
    await page.keyboard.press('Escape')
  }
})

test('small screens keep the canvas and settings within the workspace', async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await openBuilder(page)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true)
    expect(
      await page
        .getByRole('main')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await addNode(page, 'Spawn agent')
    await expect(page.getByLabel('Step name', { exact: true })).toBeVisible()
    await page.getByLabel('Step name', { exact: true }).fill('Mobile step')
    await page.getByRole('button', { name: 'Close settings' }).click()
    const canvas = await page
      .getByRole('region', { name: 'Workflow canvas', exact: true })
      .boundingBox()
    expect(canvas!.width).toBeGreaterThan(150)
    expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(width + 1)
    await page.evaluate((key) => localStorage.removeItem(key), LIBRARY_KEY)
  }
})
