// Retained for when the workflow UI returns to the workspace.
import { expect, test, type Locator, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { readFile } from 'node:fs/promises'
import type { Branch, Workflow } from '../src/workflows/ir'
const fixture = async (name = 'workflow'): Promise<Workflow> =>
  JSON.parse(
    await readFile(`../../workflow/ir/examples/branching/${name}.json`, 'utf8')
  )
const step = (page: Page, id: string) => page.locator(`[data-step-id="${id}"]`)
const validation = (page: Page) =>
  page.getByRole('region', { name: 'Workflow validation' })
const block = (page: Page, path: string) =>
  page.locator(`[data-sequence-path="${path}"] > .wf-add-step`)
const document = async (page: Page): Promise<Workflow> =>
  JSON.parse((await page.getByLabel('Current workflow IR').textContent())!)
async function valid(page: Page) {
  await expect(validation(page).getByRole('status')).toHaveText(
    'Valid Aixand IR v0.2'
  )
}
async function connect(page: Page) {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(
    page.getByText('Connected to workspace', { exact: true })
  ).toBeVisible()
}
async function load(page: Page, workflow: Workflow) {
  await page.getByRole('button', { name: 'Import IR', exact: true }).click()
  await page.getByLabel('Workflow IR to import').fill(JSON.stringify(workflow))
  await page.getByRole('button', { name: 'Load document', exact: true }).click()
}
async function exported(page: Page) {
  await valid(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export IR', exact: true }).click()
  return JSON.parse(await readFile((await (await download).path())!, 'utf8'))
}
async function add(scope: Locator, operation: string) {
  await scope.getByLabel('Operation catalog').selectOption(`${operation}@1.0.0`)
  await scope.getByRole('button', { name: 'Add Step', exact: true }).click()
}
async function verifier(page: Page, scope: Locator, id: string, title: string) {
  await add(scope, 'verifier.verify')
  const card = step(page, id)
  await card
    .getByLabel('document expression', { exact: true })
    .selectOption('object')
  for (let i = 0; i < 3; i++)
    await card
      .getByRole('button', { name: 'Add expression field', exact: true })
      .click()
  await card.getByLabel('title value', { exact: true }).fill(title)
  await card.getByLabel('body value', { exact: true }).fill('workflow example')
}
test('hand and Python Branch IR load, export and round trip without rewriting either document', async ({
  page,
}) => {
  await connect(page)
  for (const [button, name] of [
    ['Load branching example', 'workflow'],
    ['Load Python branch IR', 'generated'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await expect(page.locator('[data-step-id]')).toHaveCount(5)
    await expect(
      step(page, 'branch_1').getByLabel('Condition reference', { exact: true })
    ).toHaveValue(/verify_1/)
    await expect(
      page
        .getByRole('region', { name: 'branch_1 THEN', exact: true })
        .locator('[data-step-id]')
    ).toHaveCount(1)
    await expect(
      page
        .getByRole('region', { name: 'branch_1 ELSE', exact: true })
        .locator('[data-step-id]')
    ).toHaveCount(1)
    expect(await exported(page)).toEqual(await fixture(name))
    await load(page, await exported(page))
    expect(await exported(page)).toEqual(await fixture(name))
  }
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(accessibility.violations).toEqual([])
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
test('author a branch and both arms visually, configure a comparison and execute the exact Web IR', async ({
  page,
}) => {
  let executedSource = ''
  await page.routeWebSocket('**/api/workflows/ws', (socket) => {
    const server = socket.connectToServer()
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'run') executedSource = message.args.source
      server.send(raw)
    })
  })
  await connect(page)
  await block(page, '/body')
    .getByRole('button', { name: 'Add Branch', exact: true })
    .click()
  const branch = step(page, 'branch_1')
  await branch
    .getByLabel('Condition expression', { exact: true })
    .selectOption('compare')
  await branch.getByLabel('Comparison operator').selectOption('ge')
  await branch.getByLabel('Left value', { exact: true }).fill('2')
  await branch.getByLabel('Left value', { exact: true }).blur()
  await branch.getByLabel('Right value', { exact: true }).fill('1')
  await branch.getByLabel('Right value', { exact: true }).blur()
  await verifier(page, block(page, '/body/steps/0/then'), 'verify_1', 'Then')
  await verifier(page, block(page, '/body/steps/0/else'), 'verify_2', 'Else')
  const saved = await exported(page)
  expect(saved.body.steps[0].condition).toEqual({
    kind: 'compare',
    operator: 'ge',
    left: { kind: 'literal', value: 2 },
    right: { kind: 'literal', value: 1 },
  })
  await page.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect(page.getByLabel('Runner events').locator('li')).toHaveText([
    'Prepared',
    'branch_1 · true · THEN selected; ELSE skipped',
    'verify_1 · Running',
    'verify_1 · Completed',
    'Workflow body completed',
  ])
  await expect(page.getByLabel('Workflow run outputs')).toHaveText('{}')
  expect(JSON.parse(executedSource)).toEqual(saved)
  await load(page, saved)
  expect(await exported(page)).toEqual(saved)
})
test('compiled workflow executes both paths through real runner events and produces outputs', async ({
  page,
}) => {
  await connect(page)
  await page
    .getByRole('button', { name: 'Load Python branch IR', exact: true })
    .click()
  await valid(page)
  const run = page.getByRole('region', { name: 'Workflow execution' })
  await run.getByLabel('Provide task', { exact: true }).check()
  for (const passed of [true, false]) {
    await run
      .getByLabel('Run task', { exact: true })
      .fill(passed ? 'A workflow' : 'A project')
    await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
    const id = passed ? 'verify_2' : 'verify_3'
    await expect(run.getByLabel('Runner events').locator('li')).toHaveText([
      'Prepared',
      'verify_1 · Running',
      'verify_1 · Completed',
      `branch_1 · ${passed} · ${passed ? 'THEN selected; ELSE' : 'ELSE selected; THEN'} skipped`,
      `${id} · Running`,
      `${id} · Completed`,
      'verify_4 · Running',
      'verify_4 · Completed',
      'Workflow body completed',
    ])
    expect(
      JSON.parse((await run.getByLabel('Workflow run outputs').textContent())!)
        .passed
    ).toBe(passed)
  }
})
test('arm operations reorder/remove and nested branches preserve globally unique IDs', async ({
  page,
}) => {
  await connect(page)
  await load(page, await fixture())
  await valid(page)
  const then = block(page, '/body/steps/1/then')
  await add(then, 'aixand.agents.spawn')
  await add(then, 'aixand.agents.spawn')
  await page
    .getByRole('button', { name: 'Move spawn_2 up', exact: true })
    .click()
  expect(
    ((await document(page)).body.steps[1] as Branch).then.steps.map(
      (step) => step.id
    )
  ).toEqual(['verify_2', 'spawn_2', 'spawn_1'])
  await page
    .getByRole('button', { name: 'Remove spawn_1', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Remove spawn_2', exact: true })
    .click()
  await then.getByRole('button', { name: 'Add Branch', exact: true }).click()
  await expect(step(page, 'branch_2')).toBeVisible()
  await valid(page)
  const saved = await exported(page)
  await load(page, saved)
  expect(await exported(page)).toEqual(saved)
  await page
    .getByRole('button', { name: 'Move branch_1 up', exact: true })
    .click()
  await expect(validation(page)).toContainText('forward_reference')
  await expect(validation(page)).toContainText('/body/steps/0/condition')
})
test('reference choices follow lexical scope and cross-arm failures identify their input', async ({
  page,
}) => {
  await connect(page)
  await load(page, await fixture())
  await valid(page)
  const card = step(page, 'verify_3')
  await card.getByText('Optional inputs', { exact: true }).click()
  await card
    .getByLabel('required_terms expression', { exact: true })
    .selectOption('ref')
  const refs = card.getByLabel('required_terms reference', { exact: true })
  await expect(refs.locator('option')).toHaveText([
    'Select a compatible reference',
    'verify_1.result.issues',
  ])
  await refs.selectOption({ label: 'verify_1.result.issues' })
  await valid(page)
  const invalid = await document(page)
  const branch = invalid.body.steps[1] as Branch
  const op = branch.else!.steps[0]
  if (op.kind !== 'operation') throw new Error('expected operation')
  op.inputs.required_terms = {
    kind: 'ref',
    source: 'step',
    step: 'verify_2',
    output: 'result',
    path: ['issues'],
  }
  await load(page, invalid)
  await expect(validation(page)).toContainText('out_of_scope')
  await expect(validation(page)).toContainText(
    '/body/steps/1/else/steps/0/inputs/required_terms'
  )
  await expect(card.locator('.wf-issues')).toContainText(
    'local to another branch'
  )
  await expect(refs.locator('option')).toHaveText([
    'Unavailable here: verify_2.result.issues',
    'verify_1.result.issues',
  ])
  await refs.selectOption({ label: 'verify_1.result.issues' })
  await valid(page)
  await add(block(page, '/body/steps/1/then'), 'aixand.agent.stop')
  await expect(
    step(page, 'stop_1').getByLabel('agent expression').locator('option')
  ).not.toContainText(['Value'])
})
test('boolean condition editing preserves and/or/not and typed reference operands', async ({
  page,
}) => {
  await connect(page)
  await load(page, await fixture())
  const branch = step(page, 'branch_1')
  await branch
    .getByLabel('Condition expression', { exact: true })
    .selectOption('and')
  await branch
    .getByLabel('Condition 1 expression', { exact: true })
    .selectOption('ref')
  await branch
    .getByLabel('Condition 1 reference', { exact: true })
    .selectOption({ label: 'verify_1.result.passed' })
  await branch
    .getByLabel('Condition 2 expression', { exact: true })
    .selectOption('not')
  await branch
    .getByLabel('Negated condition value', { exact: true })
    .selectOption('false')
  await valid(page)
  const saved = await exported(page)
  expect(saved.body.steps[1].condition.kind).toBe('and')
  expect(saved.body.steps[1].condition.operands[1]).toEqual({
    kind: 'not',
    operand: { kind: 'literal', value: false },
  })
  await load(page, saved)
  expect(await exported(page)).toEqual(saved)
  await branch
    .getByLabel('Condition expression', { exact: true })
    .selectOption('or')
  await branch
    .getByRole('button', { name: 'Add condition', exact: true })
    .click()
  await branch
    .getByRole('button', { name: 'Remove condition 3', exact: true })
    .click()
  await valid(page)
  expect((await exported(page)).body.steps[1].condition.kind).toBe('or')
})
test('missing else is preserved on import and can be added or removed visually', async ({
  page,
}) => {
  await connect(page)
  const original = await fixture()
  const branch = original.body.steps[1] as Branch
  delete branch.else
  await load(page, original)
  expect(await exported(page)).toEqual(original)
  await step(page, 'branch_1')
    .getByRole('button', { name: 'Add ELSE arm', exact: true })
    .click()
  expect(((await document(page)).body.steps[1] as Branch).else).toEqual({
    kind: 'sequence',
    steps: [],
  })
  await step(page, 'branch_1')
    .getByRole('button', { name: 'Remove ELSE arm', exact: true })
    .click()
  expect(await exported(page)).toEqual(original)
})
test('condition type errors appear at the exact condition and do not permit execution', async ({
  page,
}) => {
  await connect(page)
  const invalid = await fixture()
  ;(invalid.body.steps[1] as Branch).condition = {
    kind: 'compare',
    operator: 'ge',
    left: { kind: 'literal', value: 'wrong' },
    right: { kind: 'literal', value: 1 },
  }
  await load(page, invalid)
  await expect(validation(page)).toContainText('comparison_type')
  await expect(validation(page)).toContainText('/body/steps/1/condition')
  await expect(step(page, 'branch_1').locator('.wf-issues')).toContainText(
    'ordering requires non-null numbers'
  )
  await expect(
    page.getByRole('button', { name: 'Run Workflow', exact: true })
  ).toBeDisabled()
})

test.skip(true, 'Workflows are removed from workspace navigation and routing.')

test('a runtime condition failure reports its branch and never starts an arm', async ({
  page,
}) => {
  await connect(page)
  const workflow = await fixture()
  workflow.inputs.flags = {
    type: {
      kind: 'object',
      properties: { ready: { kind: 'boolean' } },
      required: [],
    },
    default: {},
  }
  workflow.inputs.task.default = 'workflow'
  ;(workflow.body.steps[1] as Branch).condition = {
    kind: 'ref',
    source: 'input',
    name: 'flags',
    path: ['ready'],
  }
  await load(page, workflow)
  await valid(page)
  await page.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  const run = page.getByRole('region', { name: 'Workflow execution' })
  await expect(run.getByRole('alert')).toContainText(
    'Execution failed · branch_1'
  )
  await expect(run.getByLabel('Runner events').locator('li')).toHaveCount(4)
  await expect(run.getByLabel('Runner events')).not.toContainText('selected')
  await expect(run.getByLabel('Runner events')).not.toContainText('verify_2')
  await expect(run.getByLabel('Runner events')).not.toContainText('verify_3')
  await expect(run.getByLabel('Runner events')).not.toContainText('verify_4')
  await expect(run.getByLabel('Workflow run outputs')).toHaveCount(0)
})
