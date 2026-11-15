import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { compileCanvas } from '../src/workflows/builder/compileCanvas'
import { compileSequence } from '../src/workflows/builder/compile'
import { brainImplementerDraft, legacyBrainImplementerDraft, connectionAllowed, parseDraft, sequentialDraft, serializeDraft } from '../src/workflows/builder/model'
import { nodeTerminals } from '../src/workflows/builder/terminals'
import { BRAIN_IMPLEMENTER_WORKFLOW_ID, LIBRARY_BACKUP_KEY, LIBRARY_KEY } from '../src/workflows/library'
import { savedCanvas } from './workflow-helpers'

test('legacy Carrier sequences retain correlated final reply and explicit acknowledgment', () => {
  const draft = parseDraft(serializeDraft(legacyBrainImplementerDraft()))
  draft.nodes.reverse()
  const compiled = compileSequence(draft, 'run-a')
  const steps = compiled.workflow.body.steps.filter((step) => step.kind === 'operation')
  expect(steps.map((step) => step.operation.id)).toEqual([
    'aixand.agents.spawn', 'aixand.agents.spawn', 'aixand.messaging.mailbox',
    'carrier.message.send', 'carrier.message.wait_for_reply', 'carrier.message.ack',
    'aixand.agent.wait', 'aixand.agent.wait',
  ])
  expect(steps[0].inputs.address).toEqual({ kind: 'literal', value: 'workflow/run-a/brain' })
  expect(steps[1].inputs.instructions).toMatchObject({ kind: 'literal', value: expect.stringContaining('workflow/run-a/brain') })
  expect(JSON.stringify(compiled.workflow)).not.toContain('{{')
  expect(steps[3].inputs.to).toEqual({ kind: 'literal', value: 'workflow/run-a/implementer' })
  expect(steps[4].inputs).toMatchObject({
    mailbox: { kind: 'ref', source: 'step', step: 'mailbox_1', output: 'mailbox' },
    message: { kind: 'ref', source: 'step', step: 'message_1', output: 'message' },
    sender: { kind: 'literal', value: 'workflow/run-a/implementer' },
  })
  expect(steps[5].inputs.message).toEqual({ kind: 'ref', source: 'step', step: 'reply_1', output: 'message' })
  expect(steps[6].inputs.after).toBeUndefined()
  expect(compiled.workflow.outputs.final_reply_text.value).toMatchObject({ step: 'reply_1', output: 'snapshot', path: ['content'] })
  expect(compileSequence(draft, 'run-b').workflow).not.toEqual(compiled.workflow)
  expect(compileSequence(sequentialDraft(), 'run-a').workflow).toEqual(compileSequence(sequentialDraft(), 'run-b').workflow)
})

test('the main agent owns Task → Result and Brain is an optional bidirectional capability', () => {
  const draft = parseDraft(serializeDraft(brainImplementerDraft()))
  expect(draft.mode).toBeUndefined()
  draft.nodes.reverse()
  const compiled = compileSequence(draft, 'optional-run')
  expect(compiled.order).toEqual(['task', 'implementer', 'result'])
  expect(compiled.agentGraph?.tools).toEqual(['brain'])
  const operations = compiled.workflow.body.steps.filter((step) => step.kind === 'operation')
  expect(operations.map((step) => step.id)).toEqual(['spawn_1', 'spawn_2', 'mailbox_1', 'message_1', 'reply_1', 'ack_1', 'wait_1'])
  expect(operations.at(-1)!.inputs.agent).toMatchObject({ step: 'spawn_2' })
  expect(operations[1].inputs.instructions).toMatchObject({ value: expect.stringContaining('no tool call is required') })
  expect(operations[3].inputs.content).toEqual({ kind: 'literal', value: 'Say hi.' })
  const targets = nodeTerminals(compiled, {
    spawn_1: { invocation: 'spawn_1', run_id: 'brain-run', session_id: 'brain-terminal', provider: 'codex' },
    spawn_2: { invocation: 'spawn_2', run_id: 'implementer-run', session_id: 'implementer-terminal', provider: 'codex' },
  }, null)
  expect(targets.brain.sessionId).toBe('brain-terminal')
  expect(targets.result.sessionId).toBe('implementer-terminal')
  draft.edges = draft.edges.filter((edge) => edge.sourceHandle !== 'tools')
  const detached = compileSequence(draft, 'without-tool')
  expect(detached.agentGraph?.tools).toEqual([])
  expect(detached.workflow.body.steps.filter((step) => step.kind === 'operation' && step.operation.id === 'aixand.agents.spawn')).toHaveLength(1)
  expect(JSON.stringify(detached.workflow)).not.toContain('/brain')
  expect(connectionAllowed({ source: 'implementer', target: 'brain', sourceHandle: 'tools', targetHandle: 'request' }, draft.nodes, draft.edges)).toBe(true)
  expect(connectionAllowed({ source: 'implementer', target: 'task', sourceHandle: 'out', targetHandle: 'in' }, draft.nodes, draft.edges)).toBe(false)
  expect(connectionAllowed({ source: 'brain', target: 'result', sourceHandle: 'out', targetHandle: 'in' }, draft.nodes, draft.edges)).toBe(false)
})

test('migrating the original Carrier canvas preserves edits and its backup without making Brain mandatory', async ({ page }) => {
  const draft = legacyBrainImplementerDraft()
  draft.nodes.find((node) => node.id === 'brain')!.data.profile = 'my-adviser'
  draft.nodes.find((node) => node.id === 'task')!.data.prompt = 'My own task.'
  const original = JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows: [
    { id: 'brain-implementer', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', draft },
    { id: 'sequential-hello', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', draft: sequentialDraft() },
  ] })
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) }, { key: LIBRARY_KEY, value: original })
  await page.goto('/#/workflows/brain-implementer')
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  const saved = await savedCanvas(page, 'brain-implementer')
  expect(saved.mode).toBeUndefined()
  expect(saved.nodes.find((node) => node.id === 'brain')!.data.profile).toBe('my-adviser')
  expect(saved.nodes.find((node) => node.id === 'task')!.data.prompt).toBe('My own task.')
  expect(saved.nodes.find((node) => node.id === 'implementer')!.data.prompt).toContain('finish independently')
  expect(await page.evaluate((key) => localStorage.getItem(key), LIBRARY_BACKUP_KEY)).toBe(original)
  expect((await savedCanvas(page)).nodes).toEqual(sequentialDraft().nodes)
})

test('optional tool routes are visible, editable, detachable, and accessible without exposing execution checkpoints', async ({ page }) => {
  await page.goto('/#/workflows/brain-implementer')
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await expect(page.locator('[data-id="brain"]')).toContainText('Optional')
  const edge = page.locator('.react-flow__edge[data-id="implementer-brain"]')
  await expect(edge).toBeVisible()
  await expect(edge.locator('.react-flow__edge-path')).toHaveCSS('stroke-dasharray', '6px, 5px')
  await page.locator('[data-id="task"]').click()
  await page.getByLabel('Task', { exact: true }).fill('Finish independently.')
  await page.locator('[data-id="implementer"]').click()
  await expect(page.getByText('This agent owns the task and decides whether to use connected tools. It can finish without consulting them.', { exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Close settings' }).click()
  await edge.click()
  await page.getByRole('button', { name: 'Delete connection', exact: true }).click()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connect Task to the main agent.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close execution' }).click()
  await page.getByRole('region', { name: 'Workflow canvas', exact: true }).click({ button: 'right', position: { x: 40, y: 40 } })
  await expect(page.getByRole('menuitem')).toHaveCount(16)
  await expect(page.getByRole('menuitem', { name: 'Agent tool', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.getByRole('main').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('Carrier compilation rejects conflicting inboxes, unresolved roles, wrong provider, missing replies, and invalid acknowledgment', () => {
  const invalid = (change: (draft: ReturnType<typeof legacyBrainImplementerDraft>) => void, message: string) => {
    const draft = legacyBrainImplementerDraft()
    change(draft)
    expect(() => compileSequence(draft)).toThrow(message)
  }
  invalid((draft) => { draft.nodes[1].data.address = 'brain' }, 'unique name')
  invalid((draft) => { draft.nodes[0].data.prompt = 'Ask {{missing}}' }, 'Unknown inbox')
  invalid((draft) => { draft.nodes[0].data.provider = 'opencode' }, 'currently support Codex')
  invalid((draft) => { draft.nodes[3].data.agent = 'coordinator' }, 'earlier agent with a Carrier inbox')
  invalid((draft) => { draft.nodes[4].data.message = 'answer' }, 'message sent earlier')
  invalid((draft) => { draft.nodes[5].data.message = 'task' }, 'reply received earlier')
  invalid((draft) => { draft.nodes[5].data.kind = 'wait'; draft.nodes[5].data.agent = 'brain' }, 'acknowledge every Carrier')
})

test('Carrier task, reply, and acknowledgment previews resolve Implementer’s exact terminal', () => {
  const targets = nodeTerminals(compileSequence(legacyBrainImplementerDraft()), {
    spawn_1: { invocation: 'spawn_1', run_id: 'brain-run', session_id: 'brain-terminal', provider: 'codex' },
    spawn_2: { invocation: 'spawn_2', run_id: 'implementer-run', session_id: 'implementer-terminal', provider: 'codex' },
  }, null)
  expect(targets.brain.sessionId).toBe('brain-terminal')
  for (const id of ['implementer', 'task', 'answer', 'accept', 'wait-implementer'])
    expect(targets[id].sessionId).toBe('implementer-terminal')
  expect(targets.coordinator).toBeUndefined()
  expect(targets.done).toBeUndefined()
})

test('existing saved workflows are preserved and the new workflow is added only once', async ({ page }) => {
  const draft = { ...sequentialDraft(), name: 'My saved hello' }
  const original = { id: 'sequential-hello', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', draft }
  await page.addInitScript(({ key, record }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows: [record] }))
  }, { key: LIBRARY_KEY, record: original })
  await page.goto('/#/workflows')
  await expect(page.getByRole('button', { name: 'Open Brain and Implementer', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('list', { name: 'Workflows', exact: true }).getByRole('listitem')).toHaveCount(3)
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).workflows[0], LIBRARY_KEY)).toEqual(original)
  await page.getByRole('button', { name: 'Open Brain and Implementer', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await page.locator('[data-id="brain"]').click()
  await page.getByLabel('Role instructions').fill('Answer Implementer at {{implementer}} briefly.')
  await page.reload()
  expect((await savedCanvas(page, BRAIN_IMPLEMENTER_WORKFLOW_ID)).nodes.find((node) => node.id === 'brain')!.data.prompt).toBe('Answer Implementer at {{implementer}} briefly.')
  expect((await savedCanvas(page)).name).toBe('My saved hello')
})

test('new workflow dialog can create a separate editable Brain and Implementer workflow', async ({ page }) => {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Workflow name').fill('Another team')
  await page.getByRole('button', { name: 'Starting point' }).click()
  await page.getByRole('option', { name: 'Brain and Implementer', exact: true }).click()
  await page.getByRole('button', { name: 'Create workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Another team', exact: true })).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await expect(page.getByRole('list', { name: 'Workflows', exact: true }).getByRole('listitem')).toHaveCount(4)
})

test('an uncertain Carrier submission reuses the same resolved addresses and workflow after reload', async ({ page }) => {
  const submissions: any[] = []
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
    let result: unknown = { protocol: 1 }
    if (message.op === 'submit') {
      submissions.push(message.args.submission)
      if (submissions.length === 1) {
        socket.send(JSON.stringify({ type: 'error', id: message.id, code: 'runner_timeout', message: 'Submission response lost.' }))
        return
      }
      result = { job: { id: 'original-carrier-job', state: 'completed' }, replayed: true }
    }
    if (message.op === 'events') result = { events: [], state: 'completed', next_after: 0, has_more: false }
    if (message.op === 'result') result = { id: 'original-carrier-job', state: 'completed', result: {}, error: null }
    socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
  })
  })
  const connect = async () => {
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
      await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  }
  await page.goto('/#/workflows/brain-implementer')
  await connect()
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect(page.getByRole('alert')).toContainText('Submission response lost')
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled()
  await page.reload()
  await connect()
  await expect(page.getByRole('alert')).toContainText('Run submission is unconfirmed')
  expect(submissions).toHaveLength(1)
  await page.getByRole('button', { name: 'Resume monitoring', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow completed', exact: true })).toBeVisible()
  expect(submissions).toHaveLength(2)
  expect(submissions[1]).toEqual(submissions[0])
  expect(JSON.stringify(submissions)).not.toContain('temporary-test-key')
})

test('a Carrier run waits for its final reply and cleanup, recovers after reload, and reruns with fresh addresses', async ({ page }) => {
  let phase = 0
  const submissions: any[] = []
  const compiled = compileCanvas(brainImplementerDraft(), 'preview', 1)
  const ids = Object.keys(compiled.invocations)
  const events = ids.flatMap((invocation) => [{ event: 'started', invocation }, { event: 'published', invocation }])
  const ops = compiled.workflow.workflow.body.steps.filter((step) => step.kind === 'operation')
  const adviser = ops.find((step) => compiled.invocations[step.id] === 'brain')!.id
  const primary = ops.find((step) => compiled.invocations[step.id] === 'implementer' && step.operation.id === 'aixand.agents.spawn')!.id
  events.splice(1, 0, { event: 'agent_session', invocation: adviser, run_id: 'brain-run', session_id: 'brain-terminal', provider: 'codex' } as any)
  events.splice(4, 0, { event: 'agent_session', invocation: primary, run_id: 'implementer-run', session_id: 'implementer-terminal', provider: 'codex' } as any)
  const reply = ops.find((step) => step.operation.id === 'carrier.message.wait_for_reply')!.id
  const limit = events.findIndex((event) => event.event === 'published' && event.invocation === reply)
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
    const message = JSON.parse(String(raw))
    if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
    let result: unknown = { protocol: 1 }
    if (message.op === 'submit') { submissions.push(message.args.submission); result = { job: { id: 'carrier-job', state: 'running' } } }
    if (message.op === 'events') {
      const selected = events.slice(0, phase === 0 ? limit : events.length).map((data, i) => ({ sequence: i + 1, kind: 'ir', data }))
      result = { events: selected.filter((entry) => entry.sequence > message.args.after), state: phase === 2 ? 'completed' : 'running', next_after: selected.length, has_more: false }
    }
    if (message.op === 'result') result = { id: 'carrier-job', state: 'completed', result: { final_reply_text: 'Hello from Brain!', final_reply: { sender: 'implementer', reply_to: 3, content: 'Hello from Brain!' } }, error: null }
    socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
  })
  })
  const open = async () => {
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
      await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  }
  await page.goto('/#/workflows/brain-implementer')
  await open()
  await page.getByRole('button', { name: 'Start run' }).click()
  const step = (label: string) => page.locator('.wb-run-steps li').filter({ hasText: label })
  await expect(step('Result')).toHaveAttribute('data-status', 'pending')
  await expect(page.getByRole('list', { name: 'Optional tools' })).toContainText('available')
  await page.reload()
  await open()
  await expect(step('Result')).toHaveAttribute('data-status', 'pending')
  expect(submissions).toHaveLength(1)
  phase = 1
  await expect(step('Result')).toHaveAttribute('data-status', 'pending')
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled()
  phase = 2
  await expect(page.getByRole('heading', { name: 'Workflow completed', exact: true })).toBeVisible()
  await expect(page.locator('.wb-final-reply')).toContainText('Hello from Brain!')
  await expect(page.locator('.wb-run-steps [data-status="completed"]')).toHaveCount(3)
  await expect(page.getByRole('list', { name: 'Optional tools' })).toContainText('closed')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect.poll(() => submissions.length).toBe(2)
  expect(submissions[0].workflow.workflow.body.steps.find((step: any) => step.operation.id === 'aixand.agents.spawn').inputs.address.value).not.toBe(submissions[1].workflow.workflow.body.steps.find((step: any) => step.operation.id === 'aixand.agents.spawn').inputs.address.value)
})

for (const outcome of ['cancelled', 'failed', 'uncertain'] as const) {
  test(`an optional-tool run handles ${outcome} without claiming a final result or unconfirmed cleanup`, async ({ page }) => {
    let settled = false
    const compiled = compileCanvas(brainImplementerDraft(), 'preview', 1)
    const ops = compiled.workflow.workflow.body.steps.filter((step) => step.kind === 'operation')
    const index = ops.findIndex((step) => step.operation.id === 'carrier.message.wait_for_reply')
    const progress = ops.slice(0, index + 1).map((step, position) => ({ event: position === index ? 'started' : 'published', invocation: step.id }))
    await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      let result: unknown = { protocol: 1 }
      if (message.op === 'submit') result = { job: { id: 'optional-tool-job', state: 'running' } }
      if (message.op === 'cancel') { settled = true; result = { id: 'optional-tool-job', state: 'cancelling' } }
      if (message.op === 'events') result = {
        events: progress.map((data, i) => ({ sequence: i + 1, kind: 'ir', data })).filter((entry) => entry.sequence > message.args.after),
        state: settled ? outcome : 'running', next_after: progress.length, has_more: false,
      }
      if (message.op === 'result') result = {
        id: 'optional-tool-job', state: outcome, result: null,
        error: outcome === 'failed' ? { code: 'deadline', message: 'Final Carrier reply timed out.' }
          : outcome === 'uncertain' ? { code: 'cleanup_unconfirmed', message: 'Session cleanup is unconfirmed.' } : null,
      }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
    await page.goto('/#/workflows/brain-implementer')
    await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
      await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start run' }).click()
    await expect(page.getByRole('list', { name: 'Optional tools' })).toContainText('available')
    if (outcome === 'cancelled') await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
    else settled = true
    await expect(page.getByRole('heading', { name: `Workflow ${outcome}`, exact: true })).toBeVisible()
    await expect(page.locator('.wb-run-steps li').filter({ hasText: 'Result' })).toHaveAttribute('data-status', outcome === 'cancelled' ? 'cancelled' : 'blocked')
    await expect(page.getByRole('list', { name: 'Optional tools' })).toContainText(outcome === 'uncertain' ? 'uncertain' : 'closed')
    await expect(page.locator('.wb-final-reply')).toHaveCount(0)
    await expect(page.getByText('Main task finished. Agent sessions closed.', { exact: true })).toHaveCount(0)
  })
}
