// Retained for when the workflow UI returns to the workspace.
import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import type { Workflow } from '../src/workflows/ir'

test.skip(true, 'Workflows are removed from workspace navigation and routing.')

const fixture = async (path = 'real-agent/workflow.json'): Promise<Workflow> =>
  JSON.parse(await readFile(`../../workflow/ir/examples/${path}`, 'utf8'))
const step = (page: Page, id: string) => page.locator(`[data-step-id="${id}"]`)
const validation = (page: Page) =>
  page.getByRole('region', { name: 'Workflow validation' })
async function connect(page: Page) {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(
    page.getByText('Connected to workspace', { exact: true })
  ).toBeVisible()
}
async function valid(page: Page) {
  await expect(validation(page).getByRole('status')).toHaveText(
    'Valid Aixand IR v0.1'
  )
}
async function document(page: Page): Promise<Workflow> {
  return JSON.parse(
    (await page.getByLabel('Current workflow IR').textContent())!
  )
}
async function load(page: Page, workflow: Workflow | string) {
  await page.getByRole('button', { name: 'Import IR', exact: true }).click()
  await page
    .getByLabel('Workflow IR to import')
    .fill(typeof workflow === 'string' ? workflow : JSON.stringify(workflow))
  await page.getByRole('button', { name: 'Load document', exact: true }).click()
}
async function example(page: Page) {
  await page.getByRole('button', { name: 'Load verified example' }).click()
  await expect(page.locator('[data-step-id]')).toHaveCount(6)
  await valid(page)
}
async function exported(page: Page) {
  await valid(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export IR', exact: true }).click()
  const file = await download
  return JSON.parse(await readFile((await file.path())!, 'utf8'))
}

test('verified and compiled fixtures load visually and export without destructive normalization', async ({
  page,
}) => {
  await connect(page)
  await example(page)
  await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
    'managed_codex_two_turns'
  )
  await expect(page.getByLabel('Input name', { exact: true })).toHaveValue(
    'task'
  )
  await expect(
    step(page, 'spawn').getByLabel('profile value', { exact: true })
  ).toHaveValue('backup')
  await expect(
    step(page, 'send_task').getByLabel('text reference')
  ).toHaveValue(/"name":"task"/)
  await expect(
    step(page, 'wait_task').getByLabel('after reference')
  ).toHaveValue(/send_task/)
  await expect(page.getByLabel('Output name', { exact: true })).toHaveCount(3)
  expect(await exported(page)).toEqual(await fixture())
  await page.getByRole('button', { name: 'Load compiled example' }).click()
  await expect(step(page, 'stop_1')).toBeVisible()
  const compiled = await exported(page)
  expect(compiled).toEqual(await fixture('python/managed_codex_two_turns.json'))
  await load(page, compiled)
  expect(await exported(page)).toEqual(compiled)
})

test('an unavailable backend explains connection setup without claiming a run was cancelled', async ({
  page,
}) => {
  await page.routeWebSocket('**/api/workflows/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(() => socket.close({ code: 1011 }))
  })
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Could not connect to the Aixand backend'
  )
  await expect(page.getByRole('alert')).toContainText('/api proxy')
  await expect(page.getByRole('alert')).not.toContainText('cancelled')
  await expect(
    page.getByRole('button', { name: 'Connect', exact: true })
  ).toBeEnabled()
})

test('a bridge startup error survives socket closure and pending request failures', async ({
  page,
}) => {
  await page.routeWebSocket('**/api/workflows/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') socket.send(JSON.stringify({ type: 'ready' }))
      else
        socket.send(
          JSON.stringify({
            type: 'fatal',
            message: 'Workflow bridge configuration could not be loaded',
          })
        )
    })
  })
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Workflow bridge configuration could not be loaded'
  )
  await expect(
    page.getByRole('button', { name: 'Connect', exact: true })
  ).toBeEnabled()
})

test('catalog operations add deterministic IDs, remove and reorder without rewriting references', async ({
  page,
}) => {
  await connect(page)
  await page
    .getByLabel('Operation catalog')
    .selectOption('aixand.agents.spawn@1.0.0')
  await page.getByRole('button', { name: 'Add Step', exact: true }).click()
  await page.getByRole('button', { name: 'Add Step', exact: true }).click()
  await expect(page.locator('[data-step-id]')).toHaveCount(2)
  expect((await document(page)).body.steps.map((s) => s.id)).toEqual([
    'spawn_1',
    'spawn_2',
  ])
  await page
    .getByRole('button', { name: 'Remove spawn_2', exact: true })
    .click()
  await expect(page.locator('[data-step-id]')).toHaveCount(1)
  await example(page)
  await page
    .getByRole('button', { name: 'Move send_task up', exact: true })
    .click()
  await expect(validation(page)).toContainText('forward_reference')
  await expect(validation(page)).toContainText('/body/steps/0/inputs/agent')
  await expect(step(page, 'send_task').locator('.wf-issues')).toContainText(
    'earlier'
  )
  expect((await document(page)).body.steps[0].inputs.agent).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'spawn',
    output: 'agent',
  })
  await page
    .getByRole('button', { name: 'Move send_task down', exact: true })
    .click()
  await valid(page)
  await page.getByRole('button', { name: 'Remove spawn', exact: true }).click()
  await expect(validation(page)).toContainText('unknown_reference')
  await expect(
    page.getByRole('button', { name: 'Export IR', exact: true })
  ).toBeDisabled()
})

test('a deleted producer ID is not reused to silently repair dangling references', async ({
  page,
}) => {
  await connect(page)
  await page.getByRole('button', { name: 'Load compiled example' }).click()
  await expect(step(page, 'spawn_1')).toBeVisible()
  await page
    .getByRole('button', { name: 'Remove spawn_1', exact: true })
    .click()
  await page
    .getByLabel('Operation catalog')
    .selectOption('aixand.agents.spawn@1.0.0')
  await page.getByRole('button', { name: 'Add Step', exact: true }).click()
  await expect(step(page, 'spawn_2')).toBeVisible()
  await expect(validation(page)).toContainText('unknown_reference')
})

test('literal and typed references include workflow inputs and compatible earlier outputs only', async ({
  page,
}) => {
  await connect(page)
  await example(page)
  const send = step(page, 'send_task')
  await expect(send.getByLabel('agent reference').locator('option')).toHaveText(
    ['spawn.agent']
  )
  await expect(
    send.getByLabel('agent expression').locator('option')
  ).not.toContainText(['Value'])
  const text = send.getByLabel('text reference')
  await expect(text.locator('option')).toHaveText([
    'workflow.task',
    'spawn.run_id',
  ])
  await text.selectOption({ label: 'spawn.run_id' })
  await valid(page)
  expect((await document(page)).body.steps[1].inputs.text).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'spawn',
    output: 'run_id',
  })
  await send.getByLabel('text expression').selectOption('literal')
  await send.getByLabel('text value', { exact: true }).fill('A literal task')
  expect((await exported(page)).body.steps[1].inputs.text).toEqual({
    kind: 'literal',
    value: 'A literal task',
  })
  const invalid = await fixture()
  invalid.body.steps[2].inputs.after = {
    kind: 'ref',
    source: 'step',
    step: 'spawn',
    output: 'agent',
  }
  await load(page, invalid)
  await expect(validation(page)).toContainText('incompatible_type')
  await expect(
    step(page, 'wait_task')
      .getByLabel('after reference')
      .locator('option')
      .first()
  ).toHaveText('Unavailable here: spawn.agent')
  await step(page, 'wait_task')
    .getByLabel('after reference')
    .selectOption({ label: 'send_task.receipt' })
  await valid(page)
})

test('omitted, explicit null and receipt references remain three different wait inputs', async ({
  page,
}) => {
  await connect(page)
  await example(page)
  const wait = step(page, 'wait_task')
  await wait.getByLabel('after expression').selectOption('omitted')
  expect((await exported(page)).body.steps[2].inputs).not.toHaveProperty(
    'after'
  )
  await wait
    .locator('summary')
    .filter({ hasText: /^Optional inputs$/ })
    .click()
  await wait.getByLabel('after expression').selectOption('null')
  expect((await exported(page)).body.steps[2].inputs.after).toEqual({
    kind: 'literal',
    value: null,
  })
  await wait.getByLabel('after expression').selectOption('ref')
  await wait
    .getByLabel('after reference')
    .selectOption({ label: 'send_task.receipt' })
  expect((await exported(page)).body.steps[2].inputs.after).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'send_task',
    output: 'receipt',
  })
})

test('independent catalog drives recursive object/array editing and contract defaults', async ({
  page,
}) => {
  await connect(page)
  await page
    .getByLabel('Operation catalog')
    .selectOption('verifier.verify@1.0.0')
  await page.getByRole('button', { name: 'Add Step', exact: true }).click()
  const verify = step(page, 'verify_1')
  await expect(
    verify.getByRole('heading', { name: 'Verify', exact: true })
  ).toBeVisible()
  await verify.locator('.wf-contract summary').click()
  await expect(verify).toContainText('case-sensitive substring')
  await expect(verify.locator('.wf-operation-outputs')).toContainText('result')
  await verify.getByLabel('document expression').selectOption('object')
  // Property suggestions come from the contract, regardless of operation ID.
  const object = verify.locator(
    '[data-ir-path="/body/steps/0/inputs/document"]'
  )
  await object
    .getByRole('button', { name: 'Add expression field', exact: true })
    .click()
  await object
    .getByRole('button', { name: 'Add expression field', exact: true })
    .click()
  await object
    .getByRole('button', { name: 'Add expression field', exact: true })
    .click()
  await verify.getByLabel('title value', { exact: true }).fill('Example')
  await verify
    .getByLabel('body value', { exact: true })
    .fill('A workflow document')
  await verify
    .getByRole('button', { name: 'Add expression item', exact: true })
    .click()
  await verify.getByLabel('Item 1 value', { exact: true }).fill('web')
  await verify.locator('.wf-optional summary').click()
  await expect(verify).toContainText('Uses the contract default: []')
  const saved = await exported(page)
  expect(saved.body.steps[0].inputs).toEqual({
    document: {
      kind: 'object',
      fields: {
        body: { kind: 'literal', value: 'A workflow document' },
        title: { kind: 'literal', value: 'Example' },
        labels: { kind: 'array', items: [{ kind: 'literal', value: 'web' }] },
      },
    },
  })
  await load(page, await fixture('verifier.json'))
  await valid(page)
  await expect(step(page, 'verify').getByLabel('Item 2 reference')).toHaveValue(
    /"name":"label"/
  )
  expect(await exported(page)).toEqual(await fixture('verifier.json'))
})

test('workflow inputs, defaults, types, outputs and local draft use the IR records', async ({
  page,
}) => {
  await connect(page)
  await page.getByRole('button', { name: 'Add Input', exact: true }).click()
  const inputs = page.getByRole('region', {
    name: 'Workflow inputs',
    exact: true,
  })
  await inputs.getByLabel('Input name', { exact: true }).fill('task')
  await inputs.getByLabel('Input name', { exact: true }).press('Tab')
  await inputs.getByLabel('Input description').fill('Task to perform')
  await inputs.getByLabel('Provide a default').check()
  await inputs.getByLabel('task default').fill('Check the workflow')
  await page.getByRole('button', { name: 'Add Output', exact: true }).click()
  const outputs = page.getByRole('region', {
    name: 'Workflow outputs',
    exact: true,
  })
  await outputs.getByLabel('Output name', { exact: true }).fill('echo')
  await outputs.getByLabel('Output name', { exact: true }).press('Tab')
  await outputs.getByLabel('echo expression').selectOption('ref')
  await outputs
    .getByLabel('echo reference')
    .selectOption({ label: 'workflow.task' })
  const saved = await exported(page)
  expect(saved.inputs.task).toEqual({
    type: { kind: 'string' },
    description: 'Task to perform',
    default: 'Check the workflow',
  })
  expect(saved.outputs.echo.value).toEqual({
    kind: 'ref',
    source: 'input',
    name: 'task',
  })
  await page.reload()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByLabel('Input name', { exact: true })).toHaveValue(
    'task'
  )
  expect(await exported(page)).toEqual(saved)
  await outputs
    .getByRole('button', { name: 'Remove output echo', exact: true })
    .click()
  await inputs
    .getByRole('button', { name: 'Remove input task', exact: true })
    .click()
  expect((await exported(page)).inputs).toEqual({})
  expect((await document(page)).outputs).toEqual({})
})

test('structural diagnostics reject malformed imports without overwriting the draft', async ({
  page,
}) => {
  await connect(page)
  await example(page)
  await load(page, '{"ir_version":"0.1","ir_version":"0.1"}')
  await expect(
    page.getByRole('alert').filter({ hasText: 'structural errors' })
  ).toBeVisible()
  await expect(validation(page)).toContainText('duplicate')
  expect(await document(page)).toEqual(await fixture())
})

test('nullable opaque defaults and recursive workflow input types remain portable types', async ({
  page,
}) => {
  await connect(page)
  await page.getByRole('button', { name: 'Add Input', exact: true }).click()
  const input = page.locator('[data-ir-path="/inputs/input_1"]')
  await input.getByLabel('Type', { exact: true }).selectOption('opaque')
  await input.getByLabel('Opaque type ID').fill('aixand.agent')
  await expect(input.getByLabel('Provide a default')).toBeDisabled()
  await input.getByLabel('Nullable', { exact: true }).check()
  await input.getByLabel('Provide a default').check()
  expect((await exported(page)).inputs.input_1).toEqual({
    type: {
      kind: 'opaque',
      id: 'aixand.agent',
      version: '1',
      nullable: true,
    },
    default: null,
  })
  await input.getByLabel('Provide a default').uncheck()
  await input.getByLabel('Type', { exact: true }).selectOption('object')
  await input.getByRole('button', { name: 'Add property', exact: true }).click()
  await input.getByLabel('Type', { exact: true }).nth(1).selectOption('array')
  await input.getByLabel('Item type').selectOption('integer')
  await input.getByLabel('Required property').check()
  await input.getByLabel('Allow additional properties').check()
  await input.getByLabel('Additional property type').selectOption('boolean')
  expect((await exported(page)).inputs.input_1.type).toEqual({
    kind: 'object',
    properties: { property_1: { kind: 'array', items: { kind: 'integer' } } },
    required: ['property_1'],
    additional: { kind: 'boolean' },
  })
})

test('exact serialized IR executes through the existing runner and verifier binding', async ({
  page,
}) => {
  await connect(page)
  await load(page, await fixture('verifier.json'))
  await valid(page)
  const run = page.getByRole('region', {
    name: 'Workflow execution',
    exact: true,
  })
  await run.getByLabel('Provide title', { exact: true }).check()
  await run.getByLabel('Run title', { exact: true }).fill('Architecture')
  await run.getByLabel('Provide body', { exact: true }).check()
  await run
    .getByLabel('Run body', { exact: true })
    .fill('A workflow invokes versioned operations.')
  await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(
    run.getByRole('heading', { name: 'Workflow completed', exact: true })
  ).toBeVisible()
  await expect(run.getByLabel('Runner events').locator('li')).toHaveText([
    'Prepared',
    'verify · Running',
    'verify · Completed',
    'Workflow body completed',
  ])
  expect(
    JSON.parse((await run.getByLabel('Workflow run outputs').textContent())!)
      .result
  ).toMatchObject({ passed: true, issues: [] })
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  await valid(page)
  await expect(run).toContainText('an earlier version of this draft')
  await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(run.getByLabel('Workflow run outputs')).toHaveText('{}')
})

test('explicit null workflow defaults are preserved when supplied for execution', async ({
  page,
}) => {
  await connect(page)
  await load(page, {
    ir_version: '0.1',
    inputs: {
      value: { type: { kind: 'string', nullable: true }, default: null },
    },
    body: { kind: 'sequence', steps: [] },
    outputs: {
      echo: {
        type: { kind: 'string', nullable: true },
        value: { kind: 'ref', source: 'input', name: 'value' },
      },
    },
  })
  await valid(page)
  const run = page.getByRole('region', { name: 'Workflow execution' })
  await run.getByLabel('Provide value', { exact: true }).check()
  await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(run.getByLabel('Workflow run outputs')).toContainText(
    '"echo": null'
  )
})

test('existing runner preflight failures are displayed with structured details', async ({
  page,
}) => {
  await connect(page)
  await example(page)
  const run = page.getByRole('region', {
    name: 'Workflow execution',
    exact: true,
  })
  await run.getByLabel('Provide task', { exact: true }).check()
  await run
    .getByLabel('Run task', { exact: true })
    .fill('Do not launch; this test host has no SDK binding')
  await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(run.getByRole('alert')).toContainText('missing_binding')
  await expect(run.getByLabel('Runner events').locator('li')).toHaveCount(0)
  await run.getByText('Failure details', { exact: true }).click()
  await expect(run.locator('pre')).toContainText('aixand.agents.spawn')
})

test('operation failures retain invocation context, details and actual event order', async ({
  page,
}) => {
  await page.routeWebSocket('**/api/workflows/ws', (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.op !== 'run') {
        server.send(raw)
        return
      }
      const failure = {
        code: 'sdk_failure',
        message: 'Delivery failed',
        invocation_id: 'send_task',
        operation: { id: 'aixand.agent.send', version: '1.0.0' },
        details: { uncertain: true },
      }
      for (const event of [
        { event: 'prepared' },
        { event: 'started', invocation: 'spawn' },
        { event: 'published', invocation: 'spawn' },
        { event: 'started', invocation: 'send_task' },
        { event: 'failed', failure },
      ]) {
        socket.send(
          JSON.stringify({ type: 'run-event', id: request.id, event })
        )
      }
      socket.send(
        JSON.stringify({ type: 'run-failure', id: request.id, failure })
      )
    })
  })
  await connect(page)
  await example(page)
  await page.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  const run = page.getByRole('region', { name: 'Workflow execution' })
  await expect(
    run.getByRole('heading', {
      name: 'Execution failed · send_task',
      exact: true,
    })
  ).toBeVisible()
  await expect(run.getByLabel('Runner events').locator('li')).toHaveText([
    'Prepared',
    'spawn · Running',
    'spawn · Completed',
    'send_task · Running',
    'Operation failed: Delivery failed',
  ])
  await run.getByText('Failure details', { exact: true }).click()
  await expect(run.locator('pre')).toContainText('"uncertain": true')
  await expect(run.getByLabel('Workflow run outputs')).toHaveCount(0)
})

test('cancel and disconnect display authoritative failures without fabricated progress', async ({
  page,
}) => {
  // Only the long-running transport is faked; the real validator/runner paths
  // above use the Rust bridge. No timing or credentials are needed for cancel.
  let runId = ''
  let runs = 0
  await page.routeWebSocket('**/api/workflows/ws', (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.op === 'run') {
        if (++runs === 2) {
          socket.close({ code: 1011, reason: 'Test disconnect' })
          return
        }
        runId = request.id
        socket.send(
          JSON.stringify({
            type: 'run-event',
            id: runId,
            event: { event: 'prepared' },
          })
        )
      } else if (request.op === 'cancel') {
        socket.send(
          JSON.stringify({
            type: 'result',
            id: request.id,
            result: { requested: true },
          })
        )
        socket.send(
          JSON.stringify({
            type: 'run-failure',
            id: runId,
            failure: {
              code: 'cancelled',
              message: 'Run cancelled by the host',
            },
          })
        )
      } else server.send(raw)
    })
  })
  await connect(page)
  await valid(page)
  await page.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(page.getByLabel('Workflow name', { exact: true })).toBeDisabled()
  await expect(page.getByLabel('Runner events').locator('li')).toHaveText([
    'Prepared',
  ])
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cancelled')
  await expect(page.getByLabel('Workflow name', { exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Workflow execution' }).getByRole('alert')
  ).toContainText('connection_lost')
  await expect(page.getByLabel('Workflow name', { exact: true })).toBeEnabled()
})

test('loaded editor is accessible in both themes and fits narrow screens', async ({
  page,
}, testInfo) => {
  await connect(page)
  await example(page)
  for (const mode of ['light', 'dark']) {
    if (await page.locator('.aixand-app').getAttribute('data-bbb-mode') !== mode) {
      await page.getByRole('button', { name: /^Color mode:/ }).click()
      await expect(page.getByRole('button', {
        name: `Color mode: ${mode === 'light' ? 'Light' : 'Dark'}`,
      })).toBeFocused()
    }
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.aixand-app')).toHaveAttribute(
      'data-bbb-mode',
      mode
    )
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(results.violations, mode).toEqual([])
  }
  await step(page, 'spawn').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('workflows-dark.png') })
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page
        .getByRole('main')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      `${width}px`
    ).toBe(true)
  }
})
