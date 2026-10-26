import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { compileCanvas } from '../src/workflows/builder/compileCanvas'
import { compileSequence } from '../src/workflows/builder/compile'
import {
  parseDraft,
  sequentialDraft,
  serializeDraft,
} from '../src/workflows/builder/model'

test('compilation follows edges, preserves agent handles, and binds waits to send receipts', () => {
  const draft = sequentialDraft()
  draft.nodes.reverse()
  const compiled = compileSequence(parseDraft(serializeDraft(draft)))
  const steps = compiled.workflow.body.steps
  expect(steps.map((step) => step.id)).toEqual([
    'spawn_1',
    'send_1',
    'wait_1',
    'spawn_2',
    'send_2',
    'wait_2',
  ])
  const operations = steps.filter((step) => step.kind === 'operation')
  expect(operations[1].inputs.agent).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'spawn_1',
    output: 'agent',
  })
  expect(operations[2].inputs.after).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'send_1',
    output: 'receipt',
  })
  expect(operations[4].inputs.agent).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'spawn_2',
    output: 'agent',
  })
  expect(operations[5].inputs.after).toEqual({
    kind: 'ref',
    source: 'step',
    step: 'send_2',
    output: 'receipt',
  })
  expect(operations[1].inputs.text).toEqual({
    kind: 'literal',
    value: 'Say hi.',
  })
  expect(compiled.order).toEqual([
    'spawn-x',
    'send-x',
    'wait-x',
    'spawn-y',
    'send-y',
    'wait-y',
    'done',
  ])
})

test('compilation refuses branches, disconnected steps, premature spawning, and unresolved agents', () => {
  const branch = sequentialDraft()
  branch.edges.push({
    id: 'branch',
    source: 'send-x',
    target: 'spawn-y',
    sourceHandle: 'out',
    targetHandle: 'in',
  })
  expect(() => compileSequence(branch)).toThrow('Remove branches and merges')
  const detached = sequentialDraft()
  detached.edges.splice(2, 1)
  expect(() => compileSequence(detached)).toThrow('single starting point')
  const pending = sequentialDraft()
  pending.nodes.find((node) => node.id === 'wait-x')!.data.kind = 'spawn'
  expect(() => compileSequence(pending)).toThrow(
    'wait for the previous instruction',
  )
  const wrong = sequentialDraft()
  wrong.nodes.find((node) => node.id === 'send-x')!.data.agent = 'spawn-y'
  expect(() => compileSequence(wrong)).toThrow('spawned earlier')
  const blank = sequentialDraft()
  blank.nodes.find((node) => node.id === 'send-x')!.data.prompt = ' '
  expect(() => compileSequence(blank)).toThrow('enter an instruction')
})

for (const mode of ['light', 'dark'] as const) test(`Runner progress holds Y and Done, and reloading recovers the same job in ${mode}`, async ({
  page,
}) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
  let phase = 0
  let submissions = 0
  const calls: { op: string; args: any }[] = []
  const compiled = compileCanvas(sequentialDraft(), 'preview', 1)
  const invocations = Object.keys(compiled.invocations)
  const events = invocations.flatMap((invocation, index) => [
    {
      sequence: index * 2 + 1,
      kind: 'ir',
      data: { event: 'started', invocation },
    },
    {
      sequence: index * 2 + 2,
      kind: 'ir',
      data: { event: 'published', invocation },
    },
  ])
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      calls.push(message)
      let result: unknown
      if (message.op === 'health') result = { protocol: 1 }
      if (message.op === 'submit') {
        submissions++
        result = { job: { id: 'retained-job', state: 'queued' } }
      }
      if (message.op === 'events') {
        const all = phase === 0 ? events.slice(0, events.findIndex((event) => event.data.event === 'published' && compiled.invocations[event.data.invocation] === 'wait-x')) : phase === 1 ? events.filter((event) => compiled.invocations[event.data.invocation] !== 'done') : events
        const entries = all.filter(
          (entry) => entry.sequence > message.args.after,
        )
        result = {
          events: entries,
          state: phase === 2 ? 'completed' : 'running',
          next_after: all.at(-1)!.sequence,
          has_more: false,
        }
      }
      if (message.op === 'result')
        result = {
          id: 'retained-job',
          state: 'completed',
          result: { spawn_1_run_id: 'X', spawn_2_run_id: 'Y' },
          error: null,
        }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  const open = async () => {
    await page
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click()
      await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  }
  await page.goto('/#/workflows/sequential-hello')
  await open()
  if (mode === 'dark') {
    const inputs = page.getByRole('textbox', { name: 'Workflow inputs (JSON)', exact: true })
    await expect(inputs).toBeHidden()
    await page.getByText('Run inputs', { exact: true }).click()
    await inputs.fill('{"review":true}')
    await page.getByText('Run inputs', { exact: true }).click()
    await page.getByText('Run inputs', { exact: true }).click()
    await expect(inputs).toHaveValue('{"review":true}')
  }
  await page.getByRole('button', { name: 'Start run' }).click()
  const runStep = (label: string) =>
    page.locator('.wb-run-steps li').filter({ hasText: label })
  await expect(runStep('Wait for X')).toHaveAttribute('data-status', 'running')
  if (mode === 'dark') await page.screenshot({ path: test.info().outputPath('execution-dark.png') })
  await expect(runStep('Spawn agent Y')).toHaveAttribute(
    'data-status',
    'pending',
  )
  await expect(runStep('Done')).toHaveAttribute('data-status', 'pending')
  await page.reload()
  await open()
  await expect(runStep('Wait for X')).toHaveAttribute('data-status', 'running')
  expect(submissions).toBe(1)
  phase = 1
  await expect(runStep('Wait for Y')).toHaveAttribute(
    'data-status',
    'completed',
  )
  await expect(runStep('Done')).toHaveAttribute('data-status', 'pending')
  phase = 2
  await expect(
    page.getByRole('heading', { name: 'Workflow completed', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.wb-run-steps [data-status="completed"]'),
  ).toHaveCount(7)
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
  expect(calls.filter((message) => message.op === 'submit')).toHaveLength(1)
  const submitted = calls.find((message) => message.op === 'submit')!
  expect(
    submitted.args.submission.workflow.workflow.body.steps.map((step: any) => step.id),
  ).toEqual(invocations)
  expect(submitted.args.submission.key).toMatch(/^workflow-builder:/)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test('incomplete workflows cannot start and can be reset to the sequential workflow', async ({
  page,
}) => {
  await page.goto('/#/workflows/sequential-hello')
  await page.locator('.react-flow__node[data-id="done"]').click()
  await page.getByRole('button', { name: 'Delete step', exact: true }).click()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled()
  await expect(
    page.getByText(/Finish a path with Result, Done, or Main inbox\./),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Use Sequential hello', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Sequential hello', exact: true }),
  ).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
})

test('a lost submission response recovers with the same key and prevents a second fresh run', async ({
  page,
}) => {
  const keys: string[] = []
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      let result: unknown = { protocol: 1 }
      if (message.op === 'submit') {
        keys.push(message.args.submission.key)
        if (keys.length === 1) {
          socket.send(
            JSON.stringify({
              type: 'error',
              id: message.id,
              code: 'runner_timeout',
              message: 'Submission response lost.',
            }),
          )
          return
        }
        result = {
          job: { id: 'original-job', state: 'completed' },
          replayed: true,
        }
      }
      if (message.op === 'events')
        result = {
          events: [],
          state: 'completed',
          next_after: 0,
          has_more: false,
        }
      if (message.op === 'result')
        result = {
          id: 'original-job',
          state: 'completed',
          result: {},
          error: null,
        }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/workflows/sequential-hello')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Submission response lost',
  )
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled()
  await page.getByRole('button', { name: 'Resume monitoring' }).click()
  await expect(
    page.getByRole('heading', { name: 'Workflow completed', exact: true }),
  ).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(
    await page.evaluate(() => localStorage.getItem('aixand.workflow.run.v1:sequential-hello')),
  ).not.toContain('private-key-kept-in-memory')
})

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`${outcome} runs block or cancel later steps without completing them`, async ({
    page,
  }) => {
    let cancelled = false
    const cancellations: string[] = []
    await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw))
        if (message.op === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }))
          return
        }
        let result: unknown = { protocol: 1 }
        if (message.op === 'submit')
          result = { job: { id: 'stopped-job', state: 'running' } }
        if (message.op === 'cancel') {
          cancelled = true
          cancellations.push(message.args.id)
          result = { cancel_requested: true }
        }
        if (message.op === 'events')
          result = {
            events:
              message.args.after === 0
                ? [
                    {
                      sequence: 1,
                      kind: 'ir',
                      data: { event: 'started', invocation: 'op_4' },
                    },
                  ]
                : [],
            state: outcome === 'failed' || cancelled ? outcome : 'running',
            next_after: 1,
            has_more: false,
          }
        if (message.op === 'result')
          result = {
            id: 'stopped-job',
            state: outcome,
            result: null,
            error: {
              code: outcome,
              message:
                outcome === 'failed'
                  ? 'Agent wait timed out.'
                  : 'Cancelled by user.',
            },
          }
        socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
      })
    })
    await page.goto('/#/workflows/sequential-hello')
    await page
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click()
      await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start run' }).click()
    if (outcome === 'cancelled') {
      await expect(
        page.locator('.wb-run-steps li').filter({ hasText: 'Wait for X' }),
      ).toHaveAttribute('data-status', 'running')
      await page.getByRole('button', { name: 'Cancel run' }).click()
    }
    await expect(
      page.getByRole('heading', { name: `Workflow ${outcome}`, exact: true }),
    ).toBeVisible()
    for (const label of [
      'Spawn agent Y',
      'Send instruction to Y',
      'Wait for Y',
      'Done',
    ])
      await expect(
        page.locator('.wb-run-steps li').filter({ hasText: label }),
      ).toHaveAttribute('data-status', outcome === 'failed' ? 'blocked' : 'cancelled')
    await expect(
      page.locator('.wb-run-steps li').filter({ hasText: 'Wait for X' }),
    ).toHaveAttribute('data-status', outcome)
    expect(cancellations).toEqual(
      outcome === 'cancelled' ? ['stopped-job'] : [],
    )
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
  })
}
