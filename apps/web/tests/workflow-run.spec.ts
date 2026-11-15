import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ChatWorkflow } from '../src/chats/model'
import type { CarrierMessage } from '../src/carrier/client'

const controllerId = '11111111-1111-4111-8111-111111111111'
const architectureId = '33333333-3333-4333-8333-333333333333'
const securityId = '44444444-4444-4444-8444-444444444444'
const taskId = '55555555-5555-4555-8555-555555555555'
const initial: ChatWorkflow = {
  key: '66666666-6666-4666-8666-666666666666', id: 'JOB-live-graph', accepted: true, originChatId: controllerId,
  projectId: '22222222-2222-4222-8222-222222222222', project: 'Project X', title: 'Project X audits and task planning',
  state: 'running', revision: 1, createdAt: 1, updatedAt: 1, deliveryStep: 'tasks', delivery: null,
  definition: { profile: 'work', model: 'fixture-model', steps: [
    { id: 'architecture', instruction: 'Audit architecture and cite source files.' },
    { id: 'security', instruction: 'Audit security and explain impact.' },
    { id: 'tasks', instruction: 'Read both reports and prioritize tasks.' },
  ] },
  steps: [{ id: 'architecture', title: 'Architecture audit', dependsOn: [], state: 'running', chat_id: architectureId },
    { id: 'security', title: 'Security audit', dependsOn: [], state: 'running', chat_id: securityId },
    { id: 'tasks', title: 'Task planning', dependsOn: ['architecture', 'security'], state: 'pending' }],
}
type Operation = { id: string; op: string; args: Record<string, unknown> }

async function fixture(page: Page, saved = initial, delayOpen = false, options: { holdReport?: boolean; missingReport?: boolean; holdAction?: boolean; holdAck?: boolean } = {}) {
  let run = structuredClone(saved)
  let agents: WebSocketRoute
  let pendingOpen: Operation | undefined
  const errors: string[] = []
  const operations: Operation[] = []
  const carrierOperations: Operation[] = []
  const heldReports: (() => void)[] = []
  const heldActions: (() => void)[] = []
  const heldAcks: (() => void)[] = []
  let missingReport = options.missingReport
  let acknowledged = false
  const report = (): CarrierMessage => ({ id: String(run.delivery?.message_id ?? 99), title: 'Your workflow report', source: 'Workflow', sender: 'workflow/reviewer', recipient: 'suite/test/user',
    body: 'The final report is ready. Review the findings before choosing the next task.', content: 'The final report is ready.', created_at: '2026-10-18T06:00:00Z',
    direction: 'incoming', read: false, archived: true, acknowledged_at: acknowledged ? '2026-10-18T06:01:00Z' : null, reply_to: null,
    metadata: { kind: 'workflow.report', title: 'Your workflow report', links: [{ route: `workflows/runs/${run.key}`, label: 'View workflow' }] } })
  const progress = () => ({ ...run, definition: undefined })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket('**/api/workflow-jobs/ws', () => { errors.push('Native runs must not connect to the IR compiler transport') })
  const chat = (id: string) => ({ id, provider: 'codex', profile: 'work', auth: 'personal', cwd: '/project-x', project: 'Project X',
    projectId: run.projectId, mode: 'work', title: id === controllerId ? 'Audit controller' : 'Audit chat',
    status: id === controllerId ? 'completed' : 'running', createdAt: 1, updatedAt: 1, revision: 1,
    items: [], requests: [], workspaceTools: id === controllerId, workflows: id === controllerId ? [progress()] : [],
    ...(id === controllerId ? {} : { originChatId: controllerId, parentChatId: controllerId, accessMode: 'read-only' }),
  })
  await page.routeWebSocket('**/api/carrier/ws', (socket) => {
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as Operation
      if (request.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      carrierOperations.push(request)
      if (request.op === 'conversation' && missingReport) {
        socket.send(JSON.stringify({ type: 'error', id: request.id, code: 'missing_message', message: 'Message is not synchronized' }))
        return
      }
      if (request.op === 'message_get') {
        const send = () => socket.send(JSON.stringify(missingReport ? { type: 'error', id: request.id, code: 'missing_message', message: 'This report is no longer available in this inbox.' } : { type: 'result', id: request.id, result: report() }))
        if (options.holdReport) heldReports.push(send); else send()
        return
      }
      if (request.op === 'acknowledge') {
        const send = () => { acknowledged = true; socket.send(JSON.stringify({ type: 'result', id: request.id, result: { acknowledged_at: '2026-10-18T06:01:00Z' } })) }
        if (options.holdAck) heldAcks.push(send); else send()
        return
      }
      const result = request.op === 'snapshot' ? { status: { connected: true, instance: 'workflow-run-test', agent_configured: true, outgoing_history: true, providers: ['codex'], version: 1 },
        counts: {}, messages: [], total: 0, next_offset: null } : request.op === 'mailboxes' ? [{ id: 'user', address: 'suite/test/user', name: 'Main inbox', role: 'human' }] :
        request.op === 'conversation' ? { messages: [report()], total: 1, partial: false } :
        request.op === 'directory' ? { sessions: [], next_after: null } : []
      socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
    socket.send(JSON.stringify({ type: 'ready' }))
  })
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    agents = socket
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as Operation
      if (request.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(request)
      if (['chat-workflow-status', 'chat-workflow-resume', 'chat-workflow-cancel'].includes(request.op)) {
        const send = () => socket.send(JSON.stringify({ type: 'result', id: request.id, result: run }))
        if (options.holdAction) heldActions.push(send); else send()
        return
      }
      if (request.op === 'chat-workflow-open' && delayOpen) { pendingOpen = request; return }
      if (request.op === 'chat-workflow-enable-edits' && run.executionWorkflow?.format === 'aixand.chat-workflow') {
        run = { ...run, revision: run.revision + 1, planRevision: 1, phase: 'open', held: true,
          executionWorkflow: { ...run.executionWorkflow, version: 2 } }
      }
      if (['chat-workflow-hold', 'chat-workflow-release'].includes(request.op)) {
        run = { ...run, revision: run.revision + 1, held: request.op === 'chat-workflow-hold' }
      }
      if (request.op === 'chat-workflow-amend') {
        const workflow = request.args.workflow as Extract<NonNullable<ChatWorkflow['executionWorkflow']>, { format: 'aixand.chat-workflow' }>
        run = { ...run, revision: run.revision + 1, planRevision: (run.planRevision ?? 0) + 1,
          executionWorkflow: workflow, deliveryStep: workflow.delivery_step,
          definition: { profile: workflow.profile, model: workflow.model ?? null, steps: workflow.steps },
          steps: workflow.steps.map((step) => ({ ...(run.steps.find((entry) => entry.id === step.id) ?? { state: 'pending' }),
            id: step.id, title: step.title, dependsOn: step.depends_on, permissionMode: step.permission_mode })) }
      }
      const result = request.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' } :
        request.op === 'chat-list' ? [chat(controllerId), chat(architectureId), chat(securityId)] :
        request.op === 'chat-open' ? chat(String(request.args.chatId)) :
        request.op === 'chat-workflow-runs' ? { runs: [progress()], nextOffset: null } :
        request.op === 'chat-workflow-open' ? run :
        ['chat-workflow-enable-edits', 'chat-workflow-amend', 'chat-workflow-hold', 'chat-workflow-release'].includes(request.op) ? run :
        request.op === 'project-discovery-list' ? { jobs: [] } :
        request.op === 'mcp-catalog' ? { servers: [] } : []
      socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
    socket.send(JSON.stringify({ type: 'ready' }))
  })
  return { operations, carrierOperations, errors,
    releaseReport() { heldReports.splice(0).forEach(send => send()) },
    releaseAction() { heldActions.splice(0).forEach(send => send()) },
    releaseAck() { heldAcks.splice(0).forEach(send => send()) },
    restoreReport() { missingReport = false; options.holdReport = false },
    update(delta: Partial<ChatWorkflow>) {
    run = { ...run, ...delta, revision: run.revision + 1 }
    agents.send(JSON.stringify({ type: 'workflow-updated', workflow: progress() }))
  }, flushOldOpen() {
    if (!pendingOpen) throw new Error('No pending run open')
    agents.send(JSON.stringify({ type: 'result', id: pendingOpen.id, result: saved }))
  } }
}

for (const theme of ['light', 'dark']) {
  test(`workflow feedback follows work through a confirmed report and acknowledgment in ${theme}`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
    const f = await fixture(page, initial, false, { holdAction: true, holdReport: true, holdAck: true })
    await page.goto(`/#/chat/${controllerId}`)
    const card = page.getByRole('article', { name: initial.title, exact: true })
    await expect(card).toContainText('Work continues when you leave this page.')
    await card.getByRole('button', { name: 'Check status', exact: true }).click()
    await expect(card.getByRole('status').filter({ hasText: 'Checking workflow status…' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Check status', exact: true })).toBeDisabled()
    f.releaseAction()
    await expect(card).toContainText('Workflow status checked.')
    f.update({ state: 'completed', delivery: null, steps: initial.steps.map(step => ({ ...step, state: 'completed' })) })
    await expect(card).toContainText('Report delivery has not been confirmed yet.')
    await expect(card.getByRole('button', { name: 'Read report in Carrier' })).toHaveCount(0)
    f.update({ state: 'completed', delivery: { message_id: 99, address: 'suite/test/user', inbox: 'main' } })
    await expect(card.getByRole('button', { name: 'Read report in Carrier' })).toBeVisible()
    await card.getByRole('button', { name: 'View workflow', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
    await page.locator('.wb-run-panel').getByRole('button', { name: 'Read report in Carrier' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Opening your message…' })).toBeVisible()
    await expect.poll(() => f.carrierOperations.filter(op => op.op === 'message_get').length).toBeGreaterThan(0)
    expect(f.carrierOperations.find(op => op.op === 'message_get')?.args).toEqual({ mailbox: 'user', id: 99, instance: 'workflow-run-test' })
    expect(f.carrierOperations.some(op => ['acknowledge', 'send', 'set_message_state'].includes(op.op))).toBe(false)
    f.releaseReport()
    await expect(page.getByRole('heading', { name: 'Your workflow report', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Acknowledge', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Acknowledging message…' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Acknowledge', exact: true })).toBeDisabled()
    expect(f.carrierOperations.filter(op => op.op === 'acknowledge')).toHaveLength(1)
    f.releaseAck()
    await expect(page.locator('.carrier-acknowledged')).toHaveText('Acknowledged')
    await expect(page.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeFocused()
    await page.setViewportSize({ width: 390, height: 900 })
    await page.screenshot({ path: test.info().outputPath(`report-${theme}.png`), animations: 'disabled' })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    expect(f.operations.some(op => ['chat-workflow-start', 'chat-send'].includes(op.op))).toBe(false)
    expect(f.errors).toEqual([])
  })

  test(`an unavailable delivered report recovers without starting work or sending a message in ${theme}`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
    const f = await fixture(page, { ...initial, state: 'completed', delivery: { message_id: 99, address: 'suite/test/user', inbox: 'main' } }, false, { missingReport: true })
    await page.goto(`/#/chat/${controllerId}`)
    await page.getByRole('button', { name: 'Read report in Carrier', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Message unavailable' })).toBeVisible()
    await expect(page.getByText('This report is no longer available in this inbox.')).toBeVisible()
    const lookupsBeforeRetry = f.carrierOperations.filter(op => op.op === 'message_get').length
    f.restoreReport()
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your workflow report', exact: true })).toBeVisible()
    expect(f.carrierOperations.filter(op => op.op === 'message_get')).toHaveLength(lookupsBeforeRetry + 1)
    await expect(page.getByRole('button', { name: 'Retry conversation', exact: true })).toHaveCount(0)
    expect(f.carrierOperations.some(op => ['send', 'acknowledge', 'set_message_state'].includes(op.op))).toBe(false)
    expect(f.errors).toEqual([])
  })

  test(`leaving a pending report keeps a late response from reopening the reader in ${theme}`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
    const f = await fixture(page, { ...initial, state: 'completed', delivery: { message_id: 99, address: 'suite/test/user', inbox: 'main' } }, false, { holdReport: true })
    await page.goto(`/#/chat/${controllerId}`)
    await page.getByRole('button', { name: 'Read report in Carrier', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Opening your message…' })).toBeVisible()
    await expect.poll(() => f.carrierOperations.filter(op => op.op === 'message_get').length).toBeGreaterThan(0)
    await page.setViewportSize({ width: 390, height: 900 })
    await page.getByRole('button', { name: 'Back to messages', exact: true }).click()
    f.releaseReport()
    await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Your workflow report', exact: true })).toHaveCount(0)
    await expect(page.locator('.carrier-reader')).toBeHidden()
    expect(f.errors).toEqual([])
  })
}

test('chat-created runs show live joins and delivery after the controller has finished', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/workflows')
  await page.getByRole('list', { name: 'Workflows', exact: true }).getByRole('button', { name: initial.title, exact: true }).click()
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  await expect(graph.locator('.react-flow__node')).toHaveCount(5)
  await expect(graph.locator('.react-flow__edge')).toHaveCount(4)
  await expect(graph).toContainText('0 of 2 successful reports received')
  f.update({ collector: { address: 'workflow/test/collector', received: 1, expected: 3 }, steps: [
    { ...initial.steps[0], state: 'completed', receipt: { messageId: 11, acknowledged: true } },
    { ...initial.steps[1], state: 'waiting' }, initial.steps[2],
  ] })
  await expect(graph).toContainText('1 of 2 successful reports received')
  await expect(graph.getByRole('button', { name: 'Open chat to respond' })).toBeVisible()
  await expect(graph.locator('[data-id="stage:tasks"]')).toContainText('Waiting for prerequisites')
  await page.reload()
  await expect(graph).toContainText('1 of 2 successful reports received')
  expect(f.operations.filter((op) => ['chat-workflow-start', 'chat-workflow-status', 'chat-send'].includes(op.op))).toEqual([])
  f.update({ state: 'completed', delivery: { message_id: 99, address: 'suite/test/user', inbox: 'main' }, steps: [
    { ...initial.steps[0], state: 'completed', receipt: { messageId: 11, acknowledged: true } },
    { ...initial.steps[1], state: 'completed', receipt: { messageId: 12, acknowledged: true } },
    { ...initial.steps[2], state: 'completed', chat_id: taskId, receipt: { messageId: 13, acknowledged: true } },
  ] })
  await expect(graph).toContainText('2 of 2 successful reports received')
  await expect(graph).toContainText('Delivery confirmed · Message 99')
  await graph.getByRole('button', { name: 'Open main inbox' }).click()
  await expect(page).toHaveURL(/#\/carrier$/)
  expect(f.errors).toEqual([])
})

test('legacy native runs can enable editing, revise pending instructions and append a task without changing started work', async ({ page }) => {
  const saved: ChatWorkflow = { ...structuredClone(initial), planRevision: 0, phase: 'legacy', lockedGroups: ['architecture', 'security'],
    executionWorkflow: { format: 'aixand.chat-workflow', version: 1, name: initial.title, project_id: initial.projectId,
      origin_chat_id: controllerId, profile: 'work', delivery_step: 'tasks', steps: initial.steps.map((step) => ({
        id: step.id, title: step.title, depends_on: step.dependsOn, instruction: initial.definition!.steps.find((entry) => entry.id === step.id)!.instruction,
        permission_mode: 'read-only',
      })) } }
  const f = await fixture(page, saved)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
  await page.getByRole('button', { name: 'Enable editing of this run', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume upcoming steps', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close execution' }).click()
  await page.locator('[data-id="stage:architecture"]').click()
  await expect(page.getByLabel('Role instructions')).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.locator('[data-id="stage:tasks"]').click()
  await page.getByLabel('Role instructions').fill('Revised pending plan instructions.')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
  await page.getByRole('button', { name: 'Append task', exact: true }).click()
  await page.getByLabel('Step name', { exact: true }).fill('Review the plan')
  await page.getByLabel('Role instructions').fill('Review the complete planning report.')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
  await page.getByRole('button', { name: 'Apply changes to this run', exact: true }).click()
  await expect(page.getByText('Changes accepted for this run.', { exact: true })).toBeVisible()
  const amendment = f.operations.find((entry) => entry.op === 'chat-workflow-amend')!
  expect(amendment.args.expectedRevision).toBe(1)
  const workflow = amendment.args.workflow as any
  expect(workflow.steps).toHaveLength(4)
  expect(workflow.steps[0].instruction).toBe(initial.definition!.steps[0].instruction)
  expect(workflow.steps[2].instruction).toBe('Revised pending plan instructions.')
  expect(workflow.steps[3]).toMatchObject({ title: 'Review the plan', depends_on: ['tasks'], permission_mode: 'read-only' })
  expect(workflow.delivery_step).toBe(workflow.steps[3].id)
  await page.getByRole('button', { name: 'Resume upcoming steps', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pause upcoming steps', exact: true })).toBeVisible()
  expect(f.operations.filter((entry) => ['chat-send', 'chat-workflow-start'].includes(entry.op))).toEqual([])
  expect(f.errors).toEqual([])
})

test('a chat card links to its graph and pending input links to the correct child', async ({ page }) => {
  await fixture(page, { ...initial, steps: [initial.steps[0], { ...initial.steps[1], state: 'waiting' }, initial.steps[2]] })
  await page.goto(`/#/chat/${controllerId}`)
  await page.getByRole('button', { name: 'View workflow', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/workflows/runs/${initial.key}$`))
  await page.getByRole('region', { name: 'Workflow canvas', exact: true }).getByRole('button', { name: 'Open chat to respond' }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${securityId}$`))
})

test('graph uses saved dependencies and delivery stage even when stages are declared out of order', async ({ page }) => {
  const saved = { ...initial, deliveryStep: 'security', steps: [
    { ...initial.steps[1], dependsOn: ['architecture'], state: 'pending', chat_id: null },
    initial.steps[0],
    { id: 'extra', title: 'Independent extra audit', dependsOn: [], state: 'running' },
  ] }
  await fixture(page, saved)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  await expect(graph.locator('.react-flow__node')).toHaveCount(5)
  await expect(graph.locator('.react-flow__edge')).toHaveCount(3)
  await expect(graph.locator('[data-id="stage:security:human:main"]')).toHaveCount(1)
  await expect(graph.locator('[data-id="stage:extra:human:main"]')).toHaveCount(0)
  await expect(graph).toContainText('0 of 1 successful reports received')
})

test('live progress is not replaced by an older open response and the narrow view is accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const f = await fixture(page, initial, true)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  await expect.poll(() => f.operations.some((op) => op.op === 'chat-workflow-open')).toBe(true)
  f.update({ state: 'failed', delivery: { message_id: 100, address: 'suite/test/user', inbox: 'main' },
    steps: [{ ...initial.steps[0], state: 'failed', error: 'Project evidence unavailable' }, { ...initial.steps[1], state: 'cancelled' }, { ...initial.steps[2], state: 'blocked' }] })
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  await expect(graph).toContainText('Failure delivered')
  f.flushOldOpen()
  await expect(graph).toContainText('Delivery confirmed · Message 100')
  await expect(graph.locator('[data-id="stage:tasks"]')).toContainText('Blocked')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(f.errors).toEqual([])
})

test('native runs use the normal builder inspector and keep the accepted plan fixed', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  await expect(page.locator('.wb-builder--native-run')).toBeVisible()
  await expect(graph.locator('.wb-node')).toHaveCount(5)
  await expect(page.getByRole('img', { name: 'Workflow minimap' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Arrange', exact: true })).toBeVisible()
  await graph.locator('[data-id="stage:architecture"]').click()
  const inspector = page.getByRole('complementary', { name: 'Workflow settings' })
  await expect(inspector.getByLabel('Step name', { exact: true })).toHaveValue('Architecture audit')
  await expect(inspector.getByLabel('Role instructions')).toHaveValue('Audit architecture and cite source files.')
  await expect(inspector.getByLabel('Role instructions')).toHaveAttribute('readonly', '')
  f.update({ definition: undefined, steps: [{ ...initial.steps[0], state: 'completed', receipt: { messageId: 11, acknowledged: true } }, initial.steps[1], initial.steps[2]] })
  await expect(inspector).toContainText('Completed')
  await expect(inspector.getByLabel('Role instructions')).toHaveValue('Audit architecture and cite source files.')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await graph.locator('[data-id="stage:architecture"]').click()
  await page.keyboard.press('Delete')
  await expect(graph.locator('.react-flow__node')).toHaveCount(5)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
  const progress = page.getByRole('complementary', { name: 'Workflow execution' })
  await expect(progress).toContainText('JOB-live-graph')
  await expect(progress.getByRole('list', { name: 'Run steps' })).toContainText('Architecture audit')
  await expect(progress.getByRole('button', { name: 'Cancel workflow' })).toBeVisible()
  expect(f.operations.filter((op) => ['chat-workflow-start', 'chat-workflow-status', 'chat-send'].includes(op.op))).toEqual([])
  expect(f.errors).toEqual([])
})

test('arrangement persists as a view without changing the submitted job', async ({ page }) => {
  const f = await fixture(page)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  const node = graph.locator('[data-id="stage:architecture"]')
  await expect(node).toBeVisible()
  const before = await node.evaluate((element) => (element as HTMLElement).style.transform)
  const heading = await node.locator('strong').boundingBox()
  if (!heading) throw new Error('Missing stage heading')
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2)
  await page.mouse.down()
  await page.mouse.move(heading.x + heading.width / 2 + 80, heading.y + heading.height / 2 + 20, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before)
  const after = await node.evaluate((element) => (element as HTMLElement).style.transform)
  await page.reload()
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(after)
  await page.getByRole('button', { name: 'Arrange', exact: true }).click()
  await expect.poll(() => node.evaluate((element) => (element as HTMLElement).style.transform)).toBe(before)
  expect(f.operations.filter((op) => ['chat-workflow-start', 'chat-workflow-status', 'chat-send'].includes(op.op))).toEqual([])
  expect(f.errors).toEqual([])
})


test('a deleted task shows pending report delivery without offering to reopen its chat', async ({ page }) => {
  const saved = structuredClone(initial)
  saved.steps[0] = { ...saved.steps[0], conversationDeleted: true, executionState: 'completed', reportState: 'pending' }
  await fixture(page, saved)
  await page.goto(`/#/workflows/runs/${initial.key}`)
  await page.getByRole('button', { name: 'Workflow execution', exact: true }).click()
  await expect(page.getByText('Conversation deleted', { exact: true })).toBeVisible()
  await expect(page.getByText('Work finished · report delivery pending', { exact: true }).first()).toBeVisible()
  const step = page.getByRole('list', { name: 'Run steps' }).locator('li').filter({ hasText: 'Architecture audit' })
  await expect(step.getByRole('button', { name: 'Open chat', exact: true })).toHaveCount(0)
})
