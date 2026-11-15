import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { runStorageKey } from '../src/workflows/builder/runStorage'
import { compileSequence } from '../src/workflows/builder/compile'
import { sequentialDraft } from '../src/workflows/builder/model'
import { nodeTerminals } from '../src/workflows/builder/terminals'

const identity = (invocation: string, suffix: string) => ({
  event: 'agent_session', invocation, provider: 'codex',
  run_id: `run-${suffix}`, session_id: `session-${suffix}`,
})

test('node terminals follow compiled references, including a send targeting the earlier agent', () => {
  const draft = sequentialDraft()
  draft.nodes.find((node) => node.id === 'send-y')!.data.agent = 'spawn-x'
  draft.nodes.find((node) => node.id === 'wait-y')!.data.agent = 'spawn-x'
  const targets = nodeTerminals(compileSequence(draft), {
    spawn_1: identity('spawn_1', 'x'), spawn_2: identity('spawn_2', 'y'),
  }, null)
  for (const id of ['spawn-x', 'send-x', 'wait-x', 'send-y', 'wait-y'])
    expect(targets[id].sessionId).toBe('session-x')
  expect(targets['spawn-y'].sessionId).toBe('session-y')
  expect(targets.done).toBeUndefined()
})

async function fixture(page: Page, options: { legacy?: boolean } = {}) {
  const calls: { op: string; args: any; transport: string }[] = []
  const progress: any[] = [
    { event: 'started', invocation: 'op_1' },
    ...(options.legacy ? [] : [identity('op_1', 'x')]),
    { event: 'published', invocation: 'op_1' },
    { event: 'started', invocation: 'op_2' },
  ]
  let sends = 0
  let streamSocket: any
  await page.routeWebSocket('**/api/workflow-jobs/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      calls.push({ ...message, transport: 'jobs' })
      let result: unknown
      if (message.op === 'health') result = { protocol: 1 }
      if (message.op === 'submit') { sends++; result = { job: { id: 'preview-job', state: 'running' } } }
      if (message.op === 'events') {
        const all = progress.map((data, i) => ({ sequence: i + 1, kind: 'ir', data }))
        result = { events: all.filter((entry) => entry.sequence > message.args.after),
          state: options.legacy ? 'completed' : 'running', next_after: all.length, has_more: false }
      }
      if (message.op === 'result') result = { id: 'preview-job', state: 'completed',
        result: { spawn_1_run_id: 'run-x', spawn_2_run_id: 'run-y' }, error: null }
      socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      if (message.op !== 'get') {
        const result = message.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/tmp' } : message.op === 'project-discovery-list' ? { jobs: [] } : []
        socket.send(JSON.stringify({ type: 'result', id: message.id, result }))
        return
      }
      calls.push({ ...message, transport: 'agents' })
      socket.send(JSON.stringify({ type: 'result', id: message.id,
        result: { session_id: `session-${message.args.runId.slice(-1)}` } }))
    })
  })
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    streamSocket = socket
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      calls.push({ ...message, transport: 'terminals' })
      if (message.op === 'ack') return
      const stream = `stream-${message.args.sessionId}`
      socket.send(JSON.stringify({ type: 'result', id: message.id,
        result: message.op === 'attach' ? { stream } : null }))
      if (message.op === 'attach') socket.send(JSON.stringify({
        type: 'screen', stream, sequence: '1', offset: '120', columns: 120, rows: 24,
        data: Buffer.from(`\x1b[2J\x1b[H${message.args.sessionId} says Hi!\r\n`).toString('base64'),
      }))
    })
  })
  if (options.legacy) {
    const compiled = compileSequence(sequentialDraft())
    const snapshot = { ...compiled, key: 'old-key', jobId: 'preview-job', labels: Object.fromEntries(sequentialDraft().nodes.map((node) => [node.id, node.data.label])) }
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: runStorageKey('sequential-hello'), value: snapshot })
  }
  await page.goto('/#/workflows/sequential-hello')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  if (!options.legacy) await page.getByRole('button', { name: 'Start run' }).click()
  await expect(page.locator('[data-id="send-x"]')).toContainText(options.legacy ? 'completed' : 'running')
  return { calls, progress, submissions: () => sends, gap: () => streamSocket.send(JSON.stringify({
    type: 'gap', stream: 'stream-session-x', reason: 'replay_evicted',
  })) }
}

test('clicking Spawn, Send, and Wait streams the same agent, stays read-only, and closes without cancelling', async ({ page }) => {
  const f = await fixture(page)
  for (const id of ['spawn-x', 'send-x', 'wait-x']) {
    await page.locator(`[data-id="${id}"]`).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('session-x says Hi!')
    await expect(dialog).toContainText('Read-only preview')
    const bounds = await dialog.boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(800)
    const input = dialog.locator('.xterm-helper-textarea')
    await input.focus()
    await page.keyboard.type('do not send this')
    await page.keyboard.press('Enter')
    await page.setViewportSize({ width: 1300, height: 950 })
    await page.getByRole('button', { name: 'Close terminal preview', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  await expect.poll(() => f.calls.filter((call) => call.op === 'detach').length).toBe(3)
  expect(f.calls.filter((call) => ['input', 'resize', 'stop', 'cancel'].includes(call.op))).toEqual([])
  expect(f.calls.filter((call) => call.op === 'attach').every((call) => call.args.screen === true)).toBe(true)
  expect(f.calls.some((call) => call.op === 'ack')).toBe(true)
  expect(f.submissions()).toBe(1)
})

test('a pending Y preview opens automatically on its session event, and retained events restore it after reload', async ({ page }) => {
  const f = await fixture(page)
  await page.locator('[data-id="send-y"]').click()
  await expect(page.getByRole('dialog')).toContainText('Waiting for this agent to spawn')
  expect(f.calls.filter((call) => call.op === 'attach')).toHaveLength(0)
  f.progress.push(identity('op_5', 'y'))
  await expect(page.getByRole('dialog')).toContainText('session-y says Hi!')
  await page.keyboard.press('Escape')
  await page.reload()
  await page.locator('[data-id="wait-y"]').click()
  await expect(page.getByRole('dialog')).toContainText('session-y says Hi!')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect(page.locator('[data-id="send-x"]')).toContainText('running')
  await page.locator('[data-id="wait-y"]').click()
  await expect(page.getByRole('dialog')).toContainText('session-y says Hi!')
  expect(f.submissions()).toBe(1)
  expect(f.calls.filter((call) => call.op === 'attach').every((call) => call.args.sessionId === 'session-y')).toBe(true)
})

test('older completed jobs resolve their exact retained run without launching an agent', async ({ page }) => {
  const f = await fixture(page, { legacy: true })
  await page.locator('[data-id="send-x"]').click()
  await expect(page.getByRole('dialog')).toContainText('session-x says Hi!')
  expect(f.calls.find((call) => call.op === 'get')?.args).toEqual({ provider: 'codex', runId: 'run-x' })
  expect(f.calls.some((call) => ['launch', 'submit'].includes(call.op))).toBe(false)
})

test('screen gaps restore automatically without sending input or resizing the terminal', async ({ page }) => {
  const f = await fixture(page)
  await page.locator('[data-id="send-x"]').click()
  await expect(page.getByRole('dialog')).toContainText('session-x says Hi!')
  f.gap()
  await expect(page.getByRole('dialog')).toContainText('Current screen restored. Some earlier output is unavailable.')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toContainText('session-x says Hi!')
  expect(f.calls.filter((call) => call.op === 'attach')).toHaveLength(2)
  expect(f.calls.some((call) => ['input', 'resize'].includes(call.op))).toBe(false)
})

test('preview is accessible on a narrow screen, keeps native terminal dimensions, and returns focus', async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const button = page.getByRole('button', { name: 'Preview terminal for Spawn agent X', exact: true })
  await button.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('session-x says Hi!')
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await expect(page.locator('.wb-terminal-viewport')).toHaveCSS('overflow-x', 'auto')
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(button).toBeFocused()
})

test('before running, the terminal icon shows an empty state and Edit step opens the existing settings', async ({ page }) => {
  await page.goto('/#/workflows/sequential-hello')
  await page.getByRole('button', { name: 'Preview terminal for Spawn agent X', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('No terminal yet')
  await page.getByRole('button', { name: 'Edit step', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Agent profile')).toHaveValue('backup')
  expect(await page.evaluate(() => localStorage.getItem('aixand.workflow.run.v1:sequential-hello'))).toBeNull()
})
