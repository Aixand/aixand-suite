import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { compileCanvas } from '../src/workflows/builder/compileCanvas'
import { blankDraft, makeNode } from '../src/workflows/builder/model'
import { LIBRARY_KEY } from '../src/workflows/library'
import { savedCanvas } from './workflow-helpers'

function drafts() {
  const first = { ...blankDraft(), name: 'Editable audit' }
  const audit = { ...makeNode('task', { x: 0, y: 0 }, 'Audit'), id: 'audit' }; audit.data.prompt = 'Original audit'
  const plan = { ...makeNode('task', { x: 0, y: 230 }, 'Plan'), id: 'plan' }; plan.data.prompt = 'Old plan'
  const result = { ...makeNode('result', { x: 0, y: 460 }, 'Result'), id: 'result' }
  first.nodes = [audit, plan, result]
  const link = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' })
  first.edges = [link('audit', 'plan'), link('plan', 'result')]
  const next = { ...blankDraft(), name: 'Follow-up' }
  const input = { ...makeNode('input', { x: 0, y: 0 }), id: 'previous' }; input.data.inputName = 'previous_result'
  const output = { ...makeNode('result', { x: 0, y: 230 }), id: 'next-result' }
  next.nodes = [input, output]; next.edges = [link(input.id, output.id)]
  return { first, next }
}

async function fixture(page: Page) {
  const { first, next } = drafts()
  const requests: { op: string; args: any }[] = []
  let workflow = compileCanvas(first, 'accepted', 2).workflow
  let authoring = first
  let revision = 1; let held = false
  let continuations: any[] = []
  const acceptedPlan = () => ({ id: 'JOB-editable', revision, workflow, authoring, held, phase: 'open', locked_groups: ['audit'], operations: { n_audit_value: 'claimed' } })
  await page.addInitScript(({ key, first, next }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ format: 'aixand.workflow-library', version: 1,
      workflows: [{ id: 'editable', draft: first, createdAt: '2026-01-01', updatedAt: '2026-01-01' }, { id: 'followup', draft: next, createdAt: '2026-01-01', updatedAt: '2026-01-01' }] }))
  }, { key: LIBRARY_KEY, first, next })
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      const result = request.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/tmp' }
        : request.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null }
          : request.op === 'project-discovery-list' ? { jobs: [] } : []
      socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
  })
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      requests.push(request)
      let result: any
      if (request.op === 'health') result = { protocol: 1, capabilities: { workflow_graphs: [1, 2], workflow_continuations: [1] } }
      if (request.op === 'submit') { workflow = request.args.submission.workflow; authoring = request.args.submission.metadata.suite_canvas; result = { job: { id: 'JOB-editable', state: 'running' } } }
      if (request.op === 'plan') result = acceptedPlan()
      if (request.op === 'events') result = { state: 'running', events: request.args.after ? [] : [{ sequence: 1, kind: 'ir', data: { event: 'started', invocation: 'n_audit_value' } }], next_after: 1, has_more: false }
      if (request.op === 'hold' || request.op === 'release') { held = request.op === 'hold'; result = acceptedPlan() }
      if (request.op === 'amend') { workflow = request.args.workflow; authoring = request.args.authoring; revision++; result = { revision, plan: acceptedPlan() } }
      if (request.op === 'continue') { result = { id: 'CONT-next', parent_id: 'JOB-editable', key: request.args.key, state: 'waiting', child_id: null, error: null }; continuations = [result] }
      if (request.op === 'continuations') result = { continuations }
      if (request.op === 'cancel_continuation') { continuations = continuations.map((row) => ({ ...row, state: 'cancelled' })); result = continuations[0] }
      socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
  })
  return { requests, first, acceptedPlan }
}

test('stable operation identities survive insertion and named inputs and exports retain full data', () => {
  const { first, next } = drafts()
  const before = compileCanvas(first, 'same', 2)
  const review = { ...makeNode('task', { x: 0, y: 130 }, 'Review'), id: 'review' }; review.data.prompt = 'Review evidence'
  first.nodes.push(review)
  first.edges = [...first.edges.filter((edge) => edge.source !== 'audit'),
    { id: 'audit-review', source: 'audit', target: 'review', sourceHandle: 'out', targetHandle: 'in' },
    { id: 'review-plan', source: 'review', target: 'plan', sourceHandle: 'out', targetHandle: 'in' }]
  const after = compileCanvas(first, 'same', 2)
  for (const [id, node] of Object.entries(before.invocations)) expect(after.invocations[id]).toBe(node)
  expect(after.workflow.groups?.review).toEqual(['n_review_value'])
  const child = compileCanvas(next, 'new', 2).workflow
  expect(child.workflow.inputs.previous_result.type).toEqual({ kind: 'json' })
  expect(child.workflow.body.steps[0].kind === 'operation' && child.workflow.body.steps[0].inputs.value).toEqual({ kind: 'ref', source: 'input', name: 'previous_result' })
  expect(child.workflow.outputs.result.type).toEqual({ kind: 'json' })
})

test('SDK workflow drafts retain stage and controller approval policies', () => {
  const draft = blankDraft()
  const worker = makeNode('chat', { x: 0, y: 0 }, 'SDK worker')
  worker.data.prompt = 'Produce a report'
  worker.data.sdkApprovalPolicy = 'deny'
  const result = makeNode('result', { x: 0, y: 460 }, 'Result')
  draft.nodes = [worker, result]
  draft.edges = [{ id: 'worker-result', source: worker.id, target: result.id, sourceHandle: 'out', targetHandle: 'in' }]
  draft.native = { projectId: 'project', controllerChatId: 'controller', sdkApprovalPolicy: 'ask' }
  const first = compileCanvas(draft, 'sdk', 2).workflow
  expect(first.context?.sdkApprovalPolicy).toBe('ask')
  expect(Object.values(first.context?.chatPolicies ?? {})[0]?.sdkApprovalPolicy).toBe('deny')
  expect(first.context?.permissionMode).toBeUndefined()
  expect(Object.values(first.context?.chatPolicies ?? {})[0]?.permissionMode).toBeUndefined()
  draft.native.permissionMode = 'workspace-write'
  worker.data.permissionMode = 'read-only'
  const sdk = compileCanvas(draft, 'sdk', 2, {}, { provider: 'claude', backend: 'claude-sdk' }).workflow
  expect(sdk.context.backend).toBe('claude-sdk')
  expect(sdk.context.permissionMode).toBeUndefined()
  expect(Object.values(sdk.context.chatPolicies ?? {})[0]?.permissionMode).toBeUndefined()
  const codex = compileCanvas(draft, 'native', 2, {}, { provider: 'codex', backend: 'native-codex' }).workflow
  expect(codex.context.sdkApprovalPolicy).toBeUndefined()
  expect(Object.values(codex.context.chatPolicies ?? {})[0]?.sdkApprovalPolicy).toBeUndefined()
})

test('pending edits apply to one run, survive reload, and save to the reusable definition only when requested', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/workflows/editable')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByText('Job: JOB-editable')).toBeVisible()
  await page.getByRole('button', { name: 'Pause upcoming steps', exact: true }).click()
  await expect(page.getByText('Upcoming steps are paused. Current tasks continue.')).toBeVisible()
  await page.locator('.react-flow__node').filter({ hasText: 'Plan' }).click()
  await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Revised plan with evidence')
  expect((await savedCanvas(page, 'editable')).nodes.find((node) => node.id === 'plan')?.data.prompt).toBe('Old plan')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Apply changes to this run', exact: true }).click()
  await expect(page.getByText('Accepted plan version 2', { exact: false })).toBeVisible()
  expect(f.requests.filter((request) => request.op === 'amend')).toHaveLength(1)
  expect((await savedCanvas(page, 'editable')).nodes.find((node) => node.id === 'plan')?.data.prompt).toBe('Old plan')
  await page.reload()
  await page.locator('.react-flow__node').filter({ hasText: 'Plan' }).click()
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toHaveValue('Revised plan with evidence')
  await page.locator('.react-flow__node').filter({ hasText: 'Audit' }).click()
  await expect(page.getByRole('textbox', { name: 'Task', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Save workflow for future runs', exact: true }).click()
  await expect.poll(async () => (await savedCanvas(page, 'editable')).nodes.find((node) => node.id === 'plan')?.data.prompt).toBe('Revised plan with evidence')
  await page.getByRole('button', { name: 'Resume upcoming steps', exact: true }).click()
  expect(f.requests.filter((request) => request.op === 'submit')).toHaveLength(1)
})

test('follow-up registration retains the target snapshot and maps a named parent result', async ({ page }) => {
  const f = await fixture(page)
  await page.goto('/#/workflows/editable')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await expect(page.getByText('Job: JOB-editable')).toBeVisible()
  await page.getByRole('button', { name: 'Add follow-up workflow', exact: true }).click()
  await page.getByRole('button', { name: / Next workflow$/ }).click()
  await page.getByRole('option', { name: 'Follow-up', exact: true }).click()
  await page.getByRole('button', { name: 'Schedule next workflow', exact: true }).click()
  await expect(page.getByText('Waiting for this run', { exact: true })).toBeVisible()
  const request = f.requests.find((entry) => entry.op === 'continue')!
  expect(request.args.input_map).toEqual({ previous_result: '/result' })
  expect(request.args.target.workflow.version).toBe(2)
  expect(request.args.target.metadata.suite_canvas.name).toBe('Follow-up')
  await page.getByRole('button', { name: 'Cancel follow-up', exact: true }).click()
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible()
})
