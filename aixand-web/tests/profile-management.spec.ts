import { test, expect, mockAuthentication, type Page } from './fixtures'
import type { AgentJob } from '../src/agents/client'
import type { ManagementAction, ManagedProfile } from '../src/agents/AgentManagementCard'
import type { ChatSnapshot } from '../src/chats/model'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

async function managementChat(page: Page) {
  await mockAuthentication(page)
  const profile: ManagedProfile = { provider: 'codex', profile: 'work', auth: null, authMode: 'files',
    identity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: `sha256:${'a'.repeat(64)}` }
  const action: ManagementAction = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sourceChatId: chatId,
    sourceCallId: 'fixture-call', sourceTurnId: 'fixture-turn', createdAt: 2, provider: 'codex', profile: 'work',
    tool: 'create_profile', status: 'completed', url: '#/agents/profiles', result: { created: true, profile } }
  const chat: ChatSnapshot = { id: chatId, provider: 'codex', profile: 'controller', auth: null, cwd: '/workspace',
    project: '', mode: 'chat', title: 'Profile setup', status: 'completed', turnId: 'fixture-turn', createdAt: 1,
    updatedAt: 2, revision: 1, items: [
      { id: 'user', type: 'userMessage', text: 'Create work for Codex', turnId: 'fixture-turn' },
      { id: 'fixture-call', type: 'dynamicToolCall', text: 'create_profile\n{}', turnId: 'fixture-turn' },
    ], requests: [] }
  const calls: { op: string; args: Record<string, unknown> }[] = []
  const jobs: AgentJob[] = []
  let emit = (_value: unknown) => {}
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', route => {
    emit = value => route.send(JSON.stringify(value))
    emit({ type: 'ready' })
    route.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (!command.op) return
      calls.push(command)
      let result: unknown = []
      if (command.op === 'catalog') result = { profiles: [{ ...profile, id: 'codex/work', active_runs: 0 }], auths: [], cwd: '/workspace',
        capabilities: [{ provider: 'codex', installed: true, budgets: true, savedModels: false, savedAuth: true, authMode: 'files' }] }
      if (command.op === 'chat-list') result = [chat]
      if (command.op === 'chat-open') result = chat
      if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      if (command.op === 'agent-management-actions') result = { actions: [action] }
      if (command.op === 'agent-profile-get') result = profile
      if (command.op === 'agent-operations') result = { operations: jobs }
      if (command.op === 'project-discovery-list') result = { jobs: [] }
      if (command.op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      if (command.op === 'mcp-catalog') result = { servers: [] }
      if (command.op === 'agent-login-challenge') result = { available: true, challenge: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE' } }
      if (command.op === 'agent-operation-start') {
        const args = command.args
        const job: AgentJob = { id: args.key, provider: args.provider, kind: args.kind, auth: args.auth,
          assignProfile: args.assignProfile, structured: args.structured, device: args.device,
          sourceChatId: args.sourceChatId, sourceTurnId: args.sourceTurnId, sourceCallId: args.sourceCallId,
          status: 'running', phase: 'awaiting-user', createdAt: 3, updatedAt: 3, cancellable: true,
          message: 'Complete sign-in in your browser.' }
        jobs.unshift(job); action.operation = job; result = job
        emit({ type: 'agent-operation-updated', operation: job })
      }
      emit({ type: 'result', id: command.id, result })
    })
  })
  await page.goto(`/#/chat/${chatId}`)
  return { calls, complete() {
    const job = jobs[0]
    job.status = 'succeeded'; job.result = { verification: 'verified', loginSaved: true, assigned: true }
    job.message = 'Sign-in completed.'; profile.auth = job.auth ?? null
    emit({ type: 'agent-operation-updated', operation: job })
  } }
}

test('profile card starts one retained login and recovers its browser challenge after reload', async ({ page }) => {
  const fixture = await managementChat(page)
  const card = page.getByRole('region', { name: 'Profile management result' })
  await expect(card).toContainText('No saved account selected')
  await card.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(card.getByLabel('Device code')).toHaveText('TEST-CODE')
  await expect(card.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  expect(fixture.calls.find(call => call.op === 'agent-operation-start')?.args).toMatchObject({ structured: true, assignProfile: 'work', sourceChatId: chatId })
  await page.reload()
  await expect(card.getByLabel('Device code')).toHaveText('TEST-CODE')
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(1)
  fixture.complete()
  await expect(card).toContainText('Sign-in completed.')
  await expect(card.getByLabel('Device code')).toHaveCount(0)
})

test('opening a profile card does not start login and links to its exact provider/profile', async ({ page }) => {
  const fixture = await managementChat(page)
  const card = page.getByRole('region', { name: 'Profile management result' })
  await expect(card).toBeVisible()
  expect(fixture.calls.filter(call => call.op === 'agent-operation-start')).toHaveLength(0)
  await card.getByRole('button', { name: 'Manage profile', exact: true }).click()
  await expect(page).toHaveURL(/agents\/profiles\?profile=codex%2Fwork/)
})
