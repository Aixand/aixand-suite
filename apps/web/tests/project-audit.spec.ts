import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { projectAuditDraft, parseDraft, serializeDraft, sequentialDraft, makeNode, connectionAllowed } from '../src/workflows/builder/model'
import { compileCanvas } from '../src/workflows/builder/compileCanvas'
import { brainImplementerDraft, nodeKinds } from '../src/workflows/builder/model'
import { runStorageKey } from '../src/workflows/builder/runStorage'
import type { ChatWorkflow } from '../src/chats/model'
import { LIBRARY_KEY, LIBRARY_BACKUP_KEY, PROJECT_AUDIT_WORKFLOW_ID } from '../src/workflows/library'
import type { SavedWorkflow } from '../src/workflows/library'
import { savedCanvas } from './workflow-helpers'

const projectId = '22222222-2222-4222-8222-222222222222'
const architectureId = '33333333-3333-4333-8333-333333333333'
const securityId = '44444444-4444-4444-8444-444444444444'
const taskId = '55555555-5555-4555-8555-555555555555'
type Operation = { id: string; op: string; args: Record<string, unknown> }

async function mockWorkspace(page: Page, uncertain = false, saved?: ChatWorkflow, defaultMode = 'read-only') {
  const operations: Operation[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let submission: any
  let runnerState = 'running'
  let submitted = 0
  await page.routeWebSocket('**/api/workflow-jobs/ws', (route) => {
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as Operation
      if (request.op === 'auth') { route.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(request)
      let result: unknown = { protocol: 1, capabilities: { workflow_graphs: [1] } }
      if (request.op === 'submit') {
        submission = request.args.submission
        submitted++
        if (uncertain && submitted === 1) { route.send(JSON.stringify({ type: 'error', id: request.id, code: 'runner_timeout', message: 'Submission response lost.' })); return }
        result = { job: { id: 'JOB-shared-test', state: runnerState } }
      }
      if (request.op === 'cancel') { runnerState = 'cancelled'; result = {} }
      if (request.op === 'resume') { runnerState = 'running'; result = {} }
      if (request.op === 'events') {
        const graph = submission?.workflow
        const all = graph?.workflow.body.steps ?? []
        const active = all.filter((step: any) => graph.dependencies[step.id].length === 0)
        const events = (runnerState === 'completed' ? all : active).flatMap((step: any, index: number) => [
          { event: 'started', invocation: step.id },
          ...(step.operation.id === 'aixand.project.chat' ? [{ event: 'chat_step', invocation: step.id, status: 'running', chat_id: index === 0 ? architectureId : index === 1 ? securityId : taskId }] : []),
          ...(runnerState === 'completed' ? [{ event: 'published', invocation: step.id }] : []),
        ]).map((data: any, index: number) => ({ kind: 'ir', sequence: index + 1, data }))
        result = { events: events.filter((event: any) => event.sequence > Number(request.args.after ?? 0)), state: runnerState, next_after: events.length, has_more: false }
      }
      if (request.op === 'result') result = { id: 'JOB-shared-test', state: runnerState, result: { delivery: { message_id: 7, inbox: 'main' } }, error: null }
      route.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
    route.send(JSON.stringify({ type: 'ready' }))
  })
  let socket: WebSocketRoute
  let workflow: ChatWorkflow | undefined = saved
  const chats: Record<string, unknown>[] = []
  await page.routeWebSocket('**/api/carrier/ws', (route) => {
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as Operation
      if (request.op === 'auth') { route.send(JSON.stringify({ type: 'ready' })); return }
      const result = request.op === 'snapshot' ? { status: { connected: true, agent_configured: true, outgoing_history: true, providers: ['codex'], version: 1 },
        counts: {}, messages: [], total: 0, next_offset: null } : request.op === 'mailboxes' ? [{ id: 'user', address: 'suite/test/user', name: 'Main inbox', role: 'human' }] :
        request.op === 'directory' ? { sessions: [], next_after: null } : []
      route.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
    route.send(JSON.stringify({ type: 'ready' }))
  })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    socket = route
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as Operation
      if (request.op === 'auth') { route.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(request)
      let result: unknown = {}
      if (request.op === 'catalog') result = { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace' }
      if (request.op === 'project-list') result = [{ id: projectId, name: 'Project X', path: '/project-x' }]
      if (request.op === 'project-discovery-list') result = { jobs: [] }
      if (request.op === 'spawn-settings-get') result = { defaultMode, revision: 0 }
      if (request.op === 'chat-workflow-prepare') result = request.args.workflow
      if (request.op === 'chat-list') result = chats
      if (request.op === 'chat-create') {
        result = { id: request.args.key, provider: 'codex', profile: 'work', auth: 'personal', model: null, projectId,
          cwd: '/project-x', project: 'Project X', mode: 'work', title: 'Audit controller', status: 'ready', workspaceTools: true,
          createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [], workflows: [] }
        if (!chats.some((chat) => chat.id === request.args.key)) chats.push(result as Record<string, unknown>)
      }
      if (request.op === 'chat-open') result = { ...chats.find((chat) => chat.id === request.args.chatId), workflows: workflow ? [workflow] : [] }
      if (request.op === 'chat-workflow-start') {
        workflow ??= { key: request.args.key as string, id: uncertain ? null : 'JOB-native-test', originChatId: request.args.chatId as string,
          deliveryStep: 'tasks',
          projectId, project: 'Project X', title: request.args.title as string, state: uncertain ? 'uncertain' : 'running', revision: 1, createdAt: 1, updatedAt: 1,
          steps: request.args.steps ? (request.args.steps as { id: string; title: string; instruction: string; dependsOn: string[] }[]).map((step, index) => ({
            id: step.id, title: step.title, dependsOn: step.dependsOn, state: step.dependsOn.length ? 'pending' : 'running', chat_id: step.dependsOn.length ? null : index === 0 ? architectureId : securityId,
          })) : [{ id: 'architecture', title: 'Architecture audit', dependsOn: [], state: 'running', chat_id: architectureId },
            { id: 'security', title: 'Security audit', dependsOn: [], state: 'running', chat_id: securityId },
            { id: 'tasks', title: 'Task planning', dependsOn: ['architecture', 'security'], state: 'pending' }], delivery: null }
        result = workflow
      }
      if (request.op === 'chat-workflow-status') result = workflow
      if (request.op === 'chat-workflow-runs') result = { runs: workflow ? [workflow] : [], nextOffset: null }
      if (request.op === 'chat-workflow-open') result = workflow
      if (request.op === 'chat-workflow-cancel' && workflow) { workflow = { ...workflow, state: 'cancelled', revision: workflow.revision + 1 }; result = workflow }
      if (['sessions', 'chat-launches', 'models'].includes(request.op)) result = []
      if (request.op === 'mcp-catalog') result = { servers: [] }
      route.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
    route.send(JSON.stringify({ type: 'ready' }))
  })
  return { operations, errors, update(delta: Partial<ChatWorkflow>) {
    runnerState = delta.state ?? runnerState
    if (!workflow) return
    workflow = { ...workflow, ...delta, revision: workflow.revision + 1 }
    socket.send(JSON.stringify({ type: 'workflow-updated', workflow }))
  } }
}

async function createAudit(page: Page) {
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Workflow name').fill('Project X audits')
  await dialog.getByRole('button', { name: 'Starting point' }).click()
  await page.getByRole('option', { name: 'Project audit → main inbox' }).click()
  await dialog.getByRole('button', { name: 'Create workflow' }).click()
  await expect(page.getByRole('heading', { name: 'Project X audits', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true }).locator('.react-flow__node')).toHaveCount(5)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: 'Project X', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

const submissions = (operations: Operation[]) => operations.filter((request) => request.op === 'submit').map((request) => request.args.submission as any)

test('workflow resource versions persist and are prepared before Runner submission', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await createAudit(page)
  await page.getByRole('button', { name: /Resource versions/ }).click()
  await page.getByRole('option', { name: 'Keep versions selected for this run', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('button', { name: /Resource versions/ })).toContainText('Keep versions selected for this run')
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  expect(submissions(fixture.operations)[0].workflow.context.resourceCapture).toBe('workflow')
  const preparation = fixture.operations.findIndex((request) => request.op === 'chat-workflow-prepare')
  const submission = fixture.operations.findIndex((request) => request.op === 'submit')
  expect(preparation).toBeGreaterThan(-1)
  expect(preparation).toBeLessThan(submission)
  expect(fixture.errors).toEqual([])
})

test('Manual blocks worker launch until access is selected, and workflow Auto and stage overrides are retained', async ({ page }) => {
  const fixture = await mockWorkspace(page, false, undefined, 'manual')
  await createAudit(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByText(/Manual access requires a mode/)).toBeVisible()
  expect(fixture.operations.filter((request) => ['chat-create', 'submit'].includes(request.op))).toEqual([])
  await page.getByRole('button', { name: /Workflow access/ }).click()
  await page.getByRole('option', { name: /Full access \/ YOLO/ }).click()
  await page.getByRole('button', { name: /Workflow profile/ }).click()
  await page.getByRole('option', { name: /Auto · highest remaining quota/ }).click()
  await page.getByLabel('Eligible profiles', { exact: true }).fill('work, backup')
  await page.locator('[data-id="architecture"]').click()
  await page.getByRole('button', { name: /Stage access/ }).click()
  await page.getByRole('option', { name: /^Read-only/ }).click()
  await page.getByRole('button', { name: /Stage profile/ }).click()
  await page.getByRole('option', { name: 'Specific profile', exact: true }).click()
  await page.getByLabel('Profile name', { exact: true }).fill('backup')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  const [submitted] = submissions(fixture.operations)
  expect(submitted.workflow.context).toMatchObject({ permissionMode: 'full-access', profileSelection: { mode: 'auto', eligibleProfiles: ['work', 'backup'] } })
  expect(Object.values(submitted.workflow.context.chatPolicies)).toContainEqual({ permissionMode: 'read-only', permissionSource: 'stage', profileSelection: { mode: 'specific', profile: 'backup' } })
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  expect(submissions(fixture.operations)).toHaveLength(1)
  expect(fixture.operations.filter((request) => request.op === 'chat-workflow-prepare')).toHaveLength(1)
})

test('every template compiles to the same Runner graph and layout or array order does not select behavior', () => {
  for (const initial of [projectAuditDraft(), sequentialDraft(), brainImplementerDraft()]) {
    const draft = parseDraft(serializeDraft(initial))
    expect(draft.mode).toBeUndefined()
    const first = compileCanvas(draft, 'same-run')
    draft.nodes.reverse(); draft.edges.reverse()
    expect(compileCanvas(draft, 'same-run').workflow).toEqual(first.workflow)
    expect(first.workflow.format).toBe('aixand.workflow-graph')
  }
})

test('required connections allow branches and joins while adviser routes reject completion dependencies and cycles', () => {
  const draft = projectAuditDraft()
  const link = (source: string, target: string) => ({ source, target, sourceHandle: 'out', targetHandle: 'in' })
  expect(connectionAllowed(link('architecture', 'tasks'), draft.nodes, draft.edges)).toBe(true)
  expect(connectionAllowed(link('tasks', 'architecture'), draft.nodes, draft.edges)).toBe(false)
  expect(connectionAllowed(link('architecture', 'main-inbox'), draft.nodes, draft.edges)).toBe(true)
  expect(connectionAllowed(link('main-inbox', 'architecture'), draft.nodes, draft.edges)).toBe(false)
  const brain = brainImplementerDraft()
  expect(connectionAllowed(link('brain', 'result'), brain.nodes, brain.edges)).toBe(false)
  const compiled = compileCanvas(brain)
  const side = compiled.workflow.workflow.body.steps.find((step) => compiled.invocations[step.id] === 'brain')!
  expect(compiled.workflow.dependencies[side.id]).toHaveLength(1) // setup needs the original task, never an adviser answer
  expect(compiled.optionalTools).toEqual(['brain'])
  expect(() => parseDraft(serializeDraft({ ...draft, edges: [...draft.edges, { id: 'cycle', ...link('tasks', 'architecture') }] }))).toThrow('cycles')
})

for (const id of ['sequential-hello', 'brain-implementer', PROJECT_AUDIT_WORKFLOW_ID]) {
  test(`${id} offers the same full node library`, async ({ page }) => {
    const fixture = await mockWorkspace(page)
    await page.goto(`/#/workflows/${id}`)
    await page.getByRole('region', { name: 'Workflow canvas', exact: true }).click({ button: 'right', position: { x: 40, y: 40 } })
    await expect(page.getByRole('menuitem')).toHaveCount(nodeKinds.length)
    for (const name of ['Project chat', 'Collector inbox', 'Main inbox', 'Agent', 'Agent tool', 'Spawn agent', 'Send instruction'])
      await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(1)
    await page.keyboard.press('Escape')
    expect(submissions(fixture.operations)).toEqual([])
    expect(fixture.errors).toEqual([])
  })
}

test('an edited saved audit form migrates into the shared canvas without launching work', async ({ page }) => {
  const canvas = projectAuditDraft()
  const old: SavedWorkflow = { id: PROJECT_AUDIT_WORKFLOW_ID, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    draft: { ...canvas, mode: 'project-audit', name: 'My existing audit', nodes: canvas.nodes.filter((node) => node.data.kind === 'chat')
      .map((node) => ({ ...node, data: { ...node.data, kind: 'spawn', prompt: node.id === 'architecture' ? 'Keep my custom architectural review.' : node.data.prompt } })),
      edges: ['architecture', 'security'].map((source) => ({ id: `${source}-tasks`, source, target: 'tasks', sourceHandle: 'out', targetHandle: 'in' })),
    } }
  const previous = JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows: [old] })
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value) }, { key: LIBRARY_KEY, value: previous })
  const fixture = await mockWorkspace(page)
  await page.goto(`/#/workflows/${PROJECT_AUDIT_WORKFLOW_ID}`)
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await page.locator('[data-id="architecture"]').click()
  await expect(page.getByLabel('Role instructions')).toHaveValue('Keep my custom architectural review.')
  expect(await page.evaluate((key) => localStorage.getItem(key), LIBRARY_BACKUP_KEY)).toBe(previous)
  await page.reload()
  expect((await savedCanvas(page, PROJECT_AUDIT_WORKFLOW_ID)).mode).toBeUndefined()
  expect(fixture.operations.filter((request) => ['chat-create', 'chat-send', 'submit'].includes(request.op))).toEqual([])
  expect(fixture.errors).toEqual([])
})

test('the saved example remains editable, is added only once, and preserves other workflows', async ({ page }) => {
  const original: SavedWorkflow = { id: 'personal-workflow', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', draft: { ...sequentialDraft(), name: 'My existing workflow' } }
  await page.addInitScript(({ key, workflow }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows: [workflow] })) }, { key: LIBRARY_KEY, workflow: original })
  const fixture = await mockWorkspace(page)
  await page.goto(`/#/workflows/${PROJECT_AUDIT_WORKFLOW_ID}`)
  await expect(page.locator('.react-flow__node')).toHaveCount(5)
  await expect(page.locator('.react-flow__edge')).toHaveCount(4)
  await page.locator('[data-id="architecture"]').click()
  await page.getByLabel('Role instructions').fill('Audit coupling and cite evidence.')
  await page.reload()
  await page.locator('[data-id="architecture"]').click()
  await expect(page.getByLabel('Role instructions')).toHaveValue('Audit coupling and cite evidence.')
  const rows: SavedWorkflow[] = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).workflows, LIBRARY_KEY)
  expect(rows.find((row) => row.id === original.id)).toEqual(original)
  expect(rows.filter((row) => row.id === PROJECT_AUDIT_WORKFLOW_ID)).toHaveLength(1)
  expect(submissions(fixture.operations)).toEqual([])
  expect(fixture.errors).toEqual([])
})

test('native audits use the shared Run panel, submit one immutable graph and resume monitoring after reload', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await createAudit(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  await expect(page.locator('.wb-run-steps li').filter({ hasText: 'Task planning' })).toHaveAttribute('data-status', 'pending')
  const [submitted] = submissions(fixture.operations)
  expect(submitted.workflow.format).toBe('aixand.workflow-graph')
  expect(submitted.workflow.context).toMatchObject({ projectId })
  const steps = submitted.workflow.workflow.body.steps
  const chats = steps.filter((step: any) => step.operation.id === 'aixand.project.chat')
  expect(chats).toHaveLength(3)
  expect(chats.filter((step: any) => !submitted.workflow.dependencies[step.id].length)).toHaveLength(2)
  expect(steps.at(-1).operation.id).toBe('carrier.human.deliver')
  expect(JSON.stringify(submitted)).not.toContain('credentials')
  await page.locator('[data-id="architecture"]').click()
  await page.getByLabel('Role instructions').fill('Instructions for a future run.')
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  expect(submissions(fixture.operations)).toHaveLength(1)
  fixture.update({ state: 'completed' })
  await expect(page.getByRole('heading', { name: 'Workflow completed', exact: true })).toBeVisible()
  await expect(page.getByLabel('Workflow run outputs')).toContainText('message_id')
  await page.getByRole('button', { name: 'Open main inbox', exact: true }).click()
  await expect(page).toHaveURL(/#\/carrier$/)
  expect(fixture.operations.filter((request) => request.op === 'chat-workflow-start')).toEqual([])
  expect(fixture.errors).toEqual([])
})

test('an uncertain native graph reconciles its accepted job without submitting or creating another controller', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await createAudit(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  fixture.update({ state: 'uncertain' })
  await expect(page.getByRole('heading', { name: 'Workflow uncertain', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resume existing run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  expect(fixture.operations.find((request) => request.op === 'resume')?.args).toEqual({ id: 'JOB-shared-test' })
  expect(submissions(fixture.operations)).toHaveLength(1)
  expect(fixture.operations.filter((request) => request.op === 'chat-create')).toHaveLength(1)
  fixture.update({ state: 'completed' })
  await expect(page.getByRole('heading', { name: 'Workflow completed', exact: true })).toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('an unconfirmed graph retries its saved request after edits without creating another controller', async ({ page }) => {
  const fixture = await mockWorkspace(page, true)
  await createAudit(page)
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Submission response lost')
  await page.locator('[data-id="architecture"]').click()
  await page.getByLabel('Role instructions').fill('Future audit instructions.')
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('submission is unconfirmed')
  expect(submissions(fixture.operations)).toHaveLength(1)
  await page.getByRole('button', { name: 'Resume monitoring', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  const sent = submissions(fixture.operations)
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0])
  const creates = fixture.operations.filter((request) => request.op === 'chat-create')
  expect(new Set(creates.map((request) => request.args.key)).size).toBe(1)
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow cancelled', exact: true })).toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('a normal empty canvas supports project chats and Main inbox through its usual connection editor', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await page.goto('/#/workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Workflow name').fill('Manual review')
  await dialog.getByRole('button', { name: 'Create workflow' }).click()
  const graph = page.getByRole('region', { name: 'Workflow canvas', exact: true })
  await graph.click({ button: 'right', position: { x: 100, y: 100 } })
  await page.getByRole('menuitem', { name: 'Project chat', exact: true }).click()
  await graph.locator('.react-flow__node').click()
  await page.getByLabel('Step name', { exact: true }).fill('Read-only review')
  await page.getByLabel('Role instructions').fill('Review this project and cite files.')
  await graph.click({ button: 'right', position: { x: 420, y: 300 } })
  await page.getByRole('menuitem', { name: 'Main inbox', exact: true }).click()
  await graph.locator('.react-flow__node').filter({ hasText: 'Read-only review' }).click()
  await page.getByRole('button', { name: / Next step$/ }).click()
  await page.getByRole('option', { name: 'Main inbox', exact: true }).click()
  await page.getByRole('button', { name: 'Connect step', exact: true }).click()
  await expect(graph.locator('.react-flow__edge')).toHaveCount(1)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: 'Project X', exact: true }).click()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Workflow running', exact: true })).toBeVisible()
  expect(submissions(fixture.operations)[0].workflow.workflow.body.steps.map((step: any) => step.operation.id)).toEqual(['aixand.project.chat', 'carrier.human.deliver'])
  expect(fixture.errors).toEqual([])
})

test('Brain can feed Result → Collector → project chat → Main inbox without making advice mandatory', () => {
  const draft = brainImplementerDraft()
  for (const kind of ['collector', 'chat', 'human-inbox'] as const) {
    const node = { ...makeNode(kind, { x: 0, y: 0 }), id: kind }
    if (kind === 'chat') node.data.prompt = 'Review the complete result and plan tasks.'
    draft.nodes.push(node)
  }
  for (const [source, target] of [['result', 'collector'], ['collector', 'chat'], ['chat', 'human-inbox']]) draft.edges.push({ id: source + target, source, target, sourceHandle: 'out', targetHandle: 'in' })
  const compiled = compileCanvas(parseDraft(serializeDraft(draft)))
  const operations = compiled.workflow.workflow.body.steps.filter((step) => step.kind === 'operation')
  expect(operations.some((step) => step.operation.id === 'carrier.message.wait_for_reply')).toBe(true)
  expect(operations.at(-1)!.operation.id).toBe('carrier.human.deliver')
  expect(compiled.optionalTools).toEqual(['brain'])
  draft.edges = draft.edges.filter((edge) => edge.sourceHandle !== 'tools')
  expect(compileCanvas(draft).optionalTools).toEqual([])
  expect(compileCanvas(draft).workflow.workflow.body.steps.filter((step) => step.kind === 'operation' && step.operation.id === 'aixand.agents.spawn')).toHaveLength(1)
})

test('old accepted audit attempts are inspected using their original key without resubmission', async ({ page }) => {
  const attempt = { key: 'old-key', chatId: '11111111-1111-4111-8111-111111111111', projectId, title: 'Original submitted audit',
    architectureInstruction: projectAuditDraft().nodes[0].data.prompt, securityInstruction: projectAuditDraft().nodes[1].data.prompt, planningInstruction: projectAuditDraft().nodes[2].data.prompt }
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `aixand.project-audit.attempt.${PROJECT_AUDIT_WORKFLOW_ID}`, value: attempt })
  const saved: ChatWorkflow = { key: attempt.key, id: 'JOB-old-audit', originChatId: attempt.chatId, projectId, project: 'Project X', title: attempt.title, state: 'running', createdAt: 1, updatedAt: 1, revision: 1,
    steps: [{ id: 'architecture', title: 'Architecture audit', dependsOn: [], state: 'running', chat_id: architectureId }, { id: 'security', title: 'Security audit', dependsOn: [], state: 'running', chat_id: securityId }, { id: 'tasks', title: 'Task planning', dependsOn: ['architecture', 'security'], state: 'pending' }] }
  const fixture = await mockWorkspace(page, false, saved)
  await page.goto(`/#/workflows/${PROJECT_AUDIT_WORKFLOW_ID}`)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Original submitted audit · Previously submitted version', { exact: true })).toBeVisible()
  await page.reload()
  await expect.poll(() => fixture.operations.filter((request) => request.op === 'chat-workflow-open').length).toBeGreaterThan(1)
  expect(submissions(fixture.operations)).toEqual([])
  expect(fixture.operations.filter((request) => ['chat-create', 'chat-workflow-start'].includes(request.op))).toEqual([])
  expect(await page.evaluate((key) => localStorage.getItem(key), runStorageKey(PROJECT_AUDIT_WORKFLOW_ID))).toBeNull()
  expect(fixture.errors).toEqual([])
})

test('the shared audit canvas and configuration pass accessibility on a narrow screen', async ({ page }) => {
  const fixture = await mockWorkspace(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/workflows/${PROJECT_AUDIT_WORKFLOW_ID}`)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.getByRole('main').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(submissions(fixture.operations)).toEqual([])
  expect(fixture.errors).toEqual([])
})
