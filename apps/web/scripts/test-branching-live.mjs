// Connect to an existing Aixand Web deployment and run the deterministic
// branching fixture. No agents, new servers or authentication mechanisms.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const url = process.env.AIXAND_WEB_URL ?? process.env.INTESSIO_WEB_URL ?? 'http://127.0.0.1:5174'
const storageState = process.env.AIXAND_BROWSER_STORAGE_STATE
if (!storageState) throw new Error('Set AIXAND_BROWSER_STORAGE_STATE to a private authenticated Playwright storage-state file')
const directory = resolve(
  web,
  process.env.BRANCHING_EVIDENCE_DIR ?? 'artifacts/branching-live'
)
await mkdir(directory, { recursive: true })
const fixture = JSON.parse(
  await readFile(
    resolve(web, '../../workflow/ir/examples/branching/generated.json'),
    'utf8'
  )
)
const browser = await chromium.launch()
const runs = []
try {
  const page = await browser.newPage({
    storageState,
    viewport: { width: 1440, height: 1100 },
  })
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/workflows/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.op === 'run')
        runs.push({
          id: message.id,
          source: message.args.source,
          inputs: message.args.inputs,
          events: [],
        })
    })
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload))
      const run = runs.find((run) => run.id === message.id)
      if (!run) return
      if (message.type === 'run-event') run.events.push(message.event)
      if (message.type === 'run-result') run.outputs = message.outputs
      if (message.type === 'run-failure') run.failure = message.failure
    })
  })
  await page.goto(`${url}/#/workflows`)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(
    page.getByText('Connected to workspace', { exact: true })
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Load Python branch IR', exact: true })
    .click()
  await expect(
    page
      .getByRole('region', { name: 'Workflow validation' })
      .getByRole('status')
  ).toHaveText('Valid Aixand IR v0.2')
  expect(
    JSON.parse(await page.getByLabel('Current workflow IR').textContent())
  ).toEqual(fixture)
  await page.getByLabel('Provide task', { exact: true }).check()
  for (const passed of [true, false]) {
    await page
      .getByLabel('Run task', { exact: true })
      .fill(passed ? 'Document this workflow.' : 'Document this project.')
    await page
      .getByRole('button', { name: 'Run Workflow', exact: true })
      .click()
    await expect.poll(() => runs.at(-1)?.outputs?.passed).toBe(passed)
    const run = runs.at(-1)
    expect(run.failure).toBeUndefined()
    expect(JSON.parse(run.source)).toEqual(fixture)
    expect(
      run.events
        .filter((event) => event.event === 'started')
        .map((event) => event.invocation)
    ).toEqual(['verify_1', passed ? 'verify_2' : 'verify_3', 'verify_4'])
    expect(
      run.events.filter((event) => event.event === 'branch_evaluated')
    ).toEqual([
      {
        event: 'branch_evaluated',
        invocation: 'branch_1',
        result: passed,
        selected: passed ? 'then' : 'else',
      },
    ])
  }
  await page
    .locator('[data-step-id="branch_1"] > .wf-step-heading')
    .evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: resolve(directory, 'branch-editor.png') })
  await page.getByLabel('Runner events').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(directory, 'branch-run.png') })
  await writeFile(
    resolve(directory, 'runs.json'),
    JSON.stringify(
      { url, verifiedAt: new Date().toISOString(), runs },
      null,
      2
    ) + '\n'
  )
  console.log(`Both branches verified through ${url}; evidence: ${directory}`)
} finally {
  await browser.close()
}
