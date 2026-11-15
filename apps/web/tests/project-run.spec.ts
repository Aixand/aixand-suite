import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ProjectRun } from '../src/connect/model'

const chatId = 'a11a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
const childId = 'a22a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
const runId = 'a33a1d94-dafd-4c3d-9f93-a1e6eb4c7921'
async function fixture(page: Page, purpose: 'copy' | 'test' | 'matrix' = 'test') {
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let run: ProjectRun = { id: runId, chatId, childChatId: purpose === 'copy' ? null : childId, purpose, projectId: chatId, deviceId: childId,
    sourceTurnId: 'turn', sourceCallId: 'test-call', project: 'Example', device: 'My Mac', status: 'sending', stage: 'sending',
    size: 4096, bytesSent: 1024, fileCount: 4, sourceBytes: 8192, snapshotId: 'a'.repeat(64), cwd: null,
    report: null, cancelRequested: false, error: null, revision: 2, createdAt: 1, updatedAt: 2 }
  if (purpose === 'matrix') run = { ...run, deviceId: null, childChatId: null, status: 'running', targets: [
    { ...run, id: 'b11a1d94-dafd-4c3d-9f93-a1e6eb4c7921', purpose: 'test', deviceId: null, local: true,
      device: 'Suite host (Linux)', status: 'running', cwd: '/isolated/project', childChatId: 'b22a1d94-dafd-4c3d-9f93-a1e6eb4c7921' },
    { ...run, id: childId, purpose: 'test', device: 'My Mac', status: 'sending' },
  ] }
  const chat = (id = chatId) => ({ id, profile: 'work', provider: 'codex', auth: null, model: 'model', cwd: id === chatId ? '/project' : run.cwd,
    project: 'Example', mode: 'work', title: id === chatId ? 'Test on Mac' : 'Remote test', status: 'completed', createdAt: 1, updatedAt: 2,
    revision: 1, requests: [], ...(id === childId ? { deviceId: childId, device: 'My Mac', parentChatId: chatId } : {}),
    items: id === childId ? [] : [{ id: 'user', type: 'userMessage', text: 'Copy this project to my Mac and run its tests', turnId: 'turn' },
      { id: 'test-call', type: 'dynamicToolCall', text: `${purpose === 'copy' ? 'copy_project_to_device' : purpose === 'matrix' ? 'test_project_across_devices' : 'test_project_on_device'}\nAccepted`, turnId: 'turn' },
      { id: 'reply', type: 'agentMessage', text: 'The project test has started.', turnId: 'turn' }], projectRuns: id === chatId ? [run] : [] })
  let emit: (value: ProjectRun) => void = () => {}
  const update = (changes: Partial<ProjectRun>) => { run = { ...run, ...changes, revision: run.revision + 1 }; emit(run) }
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    emit = (value) => route.send(JSON.stringify({ type: 'connect-project-updated', run: value }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw)); operations.push(message)
      let result: unknown = {}
      switch (message.op) {
        case 'catalog': result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/project' }; break
        case 'sessions': result = { runs: [], runtimeError: null }; break
        case 'models': case 'mcp-jobs': case 'chat-launches': case 'project-list': result = []; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'mcp-preview': result = { selection: {}, states: [] }; break
        case 'agent-operations': result = { operations: [] }; break
        case 'project-discovery-list': result = { jobs: [], nextOffset: null }; break
        case 'spawn-settings-get': result = { defaultMode: 'read-only', revision: 0 }; break
        case 'chat-list': result = purpose === 'copy' ? [chat()] : [chat(), chat(childId)]; break
        case 'chat-open': result = chat(message.args.chatId); break
        case 'connect-project-check':
          if (purpose === 'matrix') {
            update({ targets: run.targets!.map((target) => target.id === message.args.targetId || !message.args.targetId
              ? { ...target, status: 'waiting', error: null, cwd: target.cwd ?? '/Users/owner/dev/snapshot' } : target) }); result = run; break
          }
          update({ status: purpose === 'copy' ? 'completed' : 'waiting', cwd: '/Users/owner/dev/aixand-snapshots/' + runId, error: null }); result = run; break
        case 'connect-project-cancel':
          if (purpose === 'matrix') {
            update({ ...(!message.args.targetId ? { status: 'cancelled', cancelRequested: true } : {}),
              targets: run.targets!.map((target) => target.id === message.args.targetId || !message.args.targetId
                ? { ...target, status: 'cancelled', cancelRequested: true } : target) }); result = run; break
          }
          update({ status: 'cancelled', cancelRequested: true }); result = run; break
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  return { operations, update, target: (index: number, changes: Partial<ProjectRun>) => update({ targets: run.targets!.map((target, i) => i === index ? { ...target, ...changes } : target) }), stale: () => emit({ ...run, revision: 1, status: 'sending', report: null }) }
}

test('project progress, reconnect, approval, truthful result, reload and linked chat', async ({ page }) => {
  const state = await fixture(page)
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project test: Example on My Mac', exact: true })
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', '1024')
  state.update({ profileSelection: { mode: 'auto' }, selectedProfile: 'personal',
    profileDecision: { profile: 'personal', auth: 'device-login', reason: 'Highest remaining allowance',
      quota: { weekly_left: 88, short_left: 90, checked_at: 1, account_load: 0 } } })
  await expect(card).toContainText('Auto → personal · 88% weekly allowance remaining at selection')
  state.update({ status: 'uncertain', error: 'Check this run before starting another' })
  await card.getByRole('button', { name: 'Check project run', exact: true }).click()
  await expect(card.getByText('Needs your response', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Open chat to respond', exact: true })).toBeVisible()
  expect(state.operations.find((row) => row.op === 'connect-project-check')?.args).toEqual({ chatId, runId })
  state.update({ status: 'completed', report: { outcome: 'unconfirmed', summary: 'The test runner could not be verified.', checks: [] } })
  await expect(card.getByText('Review test result', { exact: true })).toBeVisible()
  await expect(card.getByText('Tests passed', { exact: true })).toHaveCount(0)
  state.update({ report: { outcome: 'failed', summary: 'One test failed on macOS.', checks: [{ command: 'python3 -m unittest -q', exitCode: 1 }] } })
  await expect(card.getByText('Tests failed', { exact: true })).toBeVisible()
  await expect(card).toContainText('Exit 1')
  state.stale()
  await expect(card.getByText('Tests failed', { exact: true })).toBeVisible()
  await page.reload()
  await expect(card.getByText('Tests failed', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Open remote chat', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(childId))
  expect(state.operations.filter((row) => row.op === 'connect-project-start')).toHaveLength(0)
})

test('project stop and mobile accessibility', async ({ page }) => {
  const state = await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project test: Example on My Mac', exact: true })
  await card.getByRole('button', { name: 'Stop project run', exact: true }).click()
  await expect(card.getByText('Stopped', { exact: true })).toBeVisible()
  expect(state.operations.find((row) => row.op === 'connect-project-cancel')?.args).toEqual({ chatId, runId })
  await card.getByText('Snapshot details', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.connect-project-run').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('copy shows the extracted folder after recovery and reload without a test chat', async ({ page }) => {
  const state = await fixture(page, 'copy')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project copy: Example on My Mac', exact: true })
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', '1024')
  state.update({ status: 'staging' })
  await expect(card.getByText('Preparing remote folder', { exact: true })).toBeVisible()
  await expect(card.getByText('Project ready', { exact: true })).toHaveCount(0)
  state.update({ status: 'uncertain' })
  await card.getByRole('button', { name: 'Check project copy', exact: true }).click()
  await expect(card.getByText('Project ready', { exact: true })).toBeVisible()
  await expect(card).toContainText('Files copied and extracted on My Mac')
  await expect(card).toContainText('/Users/owner/dev/aixand-snapshots/' + runId)
  await expect(card.getByRole('button', { name: 'Open remote chat', exact: true })).toHaveCount(0)
  await expect(card.getByText('Tests finished', { exact: true })).toHaveCount(0)
  state.stale()
  await expect(card.getByText('Project ready', { exact: true })).toBeVisible()
  await page.reload()
  await expect(card.getByText('Project ready', { exact: true })).toBeVisible()
  expect(state.operations.filter((row) => ['chat-create', 'chat-send', 'connect-project-copy'].includes(row.op))).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.connect-project-run').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})


test('comparison keeps independent results, recovers one target, and links its chat', async ({ page }) => {
  const state = await fixture(page, 'matrix')
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project comparison: Example', exact: true })
  const host = card.getByRole('region', { name: 'Test on Suite host (Linux)', exact: true })
  const mac = card.getByRole('region', { name: 'Test on My Mac', exact: true })
  await expect(card).toHaveCount(1)
  await expect(mac.getByRole('progressbar')).toHaveAttribute('value', '1024')
  state.target(0, { status: 'completed', report: { outcome: 'passed', summary: 'Linux passed.', checks: [{ command: 'npm test', exitCode: 0 }] } })
  state.target(1, { status: 'uncertain', error: 'Mac disconnected' })
  await expect(host.getByText('Passed', { exact: true })).toBeVisible()
  await mac.getByRole('button', { name: 'Check machine', exact: true }).click()
  expect(state.operations.find((row) => row.op === 'connect-project-check')?.args).toEqual({ chatId, runId, targetId: childId })
  await expect(mac.getByRole('button', { name: 'Open chat to respond', exact: true })).toBeVisible()
  state.target(1, { status: 'completed', report: { outcome: 'failed', summary: 'Mac test failed.', checks: [{ command: 'npm test', exitCode: 1 }] } })
  state.update({ status: 'completed' })
  await expect(card.getByText('2 of 2 finished · 1 passed', { exact: true })).toBeVisible()
  await expect(mac.getByText('Failed', { exact: true })).toBeVisible()
  state.stale()
  await expect(mac.getByText('Failed', { exact: true })).toBeVisible()
  await page.reload()
  await expect(mac.getByText('Failed', { exact: true })).toBeVisible()
  await mac.getByRole('button', { name: 'Open test chat', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(childId))
  expect(state.operations.filter((row) => row.op === 'connect-project-compare')).toHaveLength(0)
})

test('comparison stops one machine separately from all machines and fits mobile', async ({ page }) => {
  const state = await fixture(page, 'matrix')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project comparison: Example', exact: true })
  const host = card.getByRole('region', { name: 'Test on Suite host (Linux)', exact: true })
  const mac = card.getByRole('region', { name: 'Test on My Mac', exact: true })
  await mac.getByRole('button', { name: 'Stop machine', exact: true }).click()
  await expect(mac.getByText('Stopped', { exact: true })).toBeVisible()
  await expect(host.getByText('Testing', { exact: true })).toBeVisible()
  expect(state.operations.find((row) => row.op === 'connect-project-cancel')?.args).toEqual({ chatId, runId, targetId: childId })
  await card.getByRole('button', { name: 'Stop all machines', exact: true }).click()
  await expect(host.getByText('Stopped', { exact: true })).toBeVisible()
  expect(state.operations.filter((row) => row.op === 'connect-project-cancel').at(-1)?.args).toEqual({ chatId, runId })
  await card.getByText('Shared source snapshot', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).include('.connect-comparison').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})


test('project reports survive deleted child history without linking to the deleted conversation', async ({ page }) => {
  const state = await fixture(page)
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('article', { name: 'Project test: Example on My Mac', exact: true })
  state.update({ cwd: '/remote/snapshot', status: 'completed', childConversationDeleted: true,
    report: { outcome: 'passed', summary: 'Retained report after deletion', checks: [{ command: 'python -m unittest', exitCode: 0 }] } })
  await expect(card).toContainText('Retained report after deletion')
  await expect(card.getByRole('button', { name: 'Open remote chat', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(card).toContainText('Retained report after deletion')
  await expect(card.getByRole('button', { name: 'Open remote chat', exact: true })).toHaveCount(0)
})
