import { test, expect, mockAuthentication, type Page } from './fixtures'
const mcpTarget = { kind: 'managed', publisher_id: 'fixture', server_id: 'default' }
const target = { kind: 'managed', store: '/device/skills', publisher_id: 'undercurrent', skill_id: 'undercurrent' }
async function mock(page: Page, stale = false, missing = false) {
  await mockAuthentication(page)
  const calls: { op: string; args: Record<string, unknown> }[] = []
  let defaults = { revision: 'sha256:' + 'a'.repeat(64), instructions: null, skills: [] as unknown[], mcp: missing ? [{ target: mcpTarget, required: true }] : [] }
  await page.routeWebSocket('**/api/agents/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(raw.toString()); if (!command.op) return
      calls.push(command)
      let result: unknown = []
      if (command.op === 'catalog') result = { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }], auths: [], capabilities: [{ provider: 'codex', installed: true, savedModels: false, budgets: false }], cwd: '/project' }
      if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      if (command.op === 'session-list') result = { sessions: [], total: 0, homes: [], projects: [], counts: {}, errors: [] }
      if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [{ label: 'undercurrent/undercurrent', target, reconciliation_required: true }], mcp: [{ label: 'fixture/default', target: mcpTarget, reconciliation_required: true }] } }
      if (command.op === 'resource-catalog' && missing) result = { choices: { instructions: [], skills: [], mcp: [] }, unavailable: ['instructions', 'skills', 'mcp'], integrations: Object.fromEntries([['instructions', 'Prompt Manager'], ['skills', 'Skill Manager'], ['mcp', 'MCP Manager']].map(([kind, manager]) => [kind, { manager, available: false, status: 'missing', reason: { message: `${manager} is not installed on the execution machine.` } }])) }
      if (command.op === 'profile-resources-get') result = defaults
      if (command.op === 'launch-preview') {
        const added = [...(command.args.resources.skills?.add ?? []).map((row: object) => ({ ...row, kind: 'skills' })), ...(command.args.resources.mcp?.add ?? []).map((row: object) => ({ ...row, kind: 'mcp' }))]
        if (missing && added.some(row => row.required)) { socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager_missing', message: 'Required MCP resource unavailable: MCP Manager is not installed.' })); return }
        result = { report: { items: added.map((row: { target: unknown; required: boolean; kind: string }, index: number) => ({ id: String(index), kind: row.kind, target: row.target, required: row.required, origin: 'explicit', status: missing ? 'skipped' : 'ready', verification: 'pending', reconciliation_required: !missing, ...(missing ? { reason: { code: 'manager_missing', message: 'MCP Manager is not installed.' } } : {}) })) } }
      }
      if (command.op === 'profile-resources-set') {
        if (stale) { socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'conflict', message: 'Profile resources changed; refresh before saving' })); return }
        defaults = { ...defaults, ...command.args.resources, revision: 'sha256:' + 'b'.repeat(64) }; result = defaults
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/agents/profiles?profile=codex%2Fwork')
  await expect(page.getByRole('heading', { name: 'Resource defaults', exact: true })).toBeVisible()
  return calls
}

test('owned skills are selectable without a release, with required policy and CAS save', async ({ page }) => {
  const calls = await mock(page)
  await page.getByText('undercurrent/undercurrent · update pending', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Required', exact: true }).press('Space')
  await expect(page.getByText('Publisher update awaiting reconciliation.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Save resource defaults' }).click()
  await expect(page.getByText('Resource defaults saved.', { exact: true })).toBeVisible()
  const saved = calls.find(row => row.op === 'profile-resources-set')!
  expect(saved.args.expectedRevision).toBe('sha256:' + 'a'.repeat(64))
  expect(saved.args.resources).toEqual({ instructions: null, skills: [{ target, required: true }], mcp: [] })
  await page.screenshot({ path: 'test-results/resources/profile-resource-defaults.png', fullPage: true })
})

test('missing managers are visible and saved MCP intent remains editable', async ({ page }) => {
  const calls = await mock(page, false, true)
  await expect(page.getByText('MCP Manager is not installed on the execution machine.', { exact: false })).toBeVisible()
  await expect(page.getByText('Prompt Manager is not installed on the execution machine.', { exact: false })).toBeVisible()
  await expect(page.getByText('Skill Manager is not installed on the execution machine.', { exact: false })).toBeVisible()
  const required = page.getByRole('checkbox', { name: 'Required', exact: true })
  await expect(required).toBeChecked()
  await expect(page.getByText('Required MCP resource unavailable:', { exact: false })).toBeVisible()
  await required.press('Space')
  await expect(page.getByText('Skipped', { exact: false }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Save resource defaults' }).click()
  await expect(page.getByText('Resource defaults saved.', { exact: true })).toBeVisible()
  expect(calls.find(row => row.op === 'profile-resources-set')!.args.resources.mcp).toEqual([{ target: mcpTarget, required: false }])
})

test('a stale save reports conflict and preserves the edited selection', async ({ page }) => {
  await mock(page, true)
  const selected = page.getByRole('checkbox', { name: 'undercurrent/undercurrent · update pending', exact: true })
  await selected.press('Space')
  await page.getByRole('button', { name: 'Save resource defaults' }).click()
  await expect(page.getByRole('alert')).toContainText('Profile resources changed')
  await expect(selected).toBeChecked()
})


test('invalid instruction input JSON cannot save stale defaults', async ({ page }) => {
  const calls = await mock(page)
  await page.getByText('Instruction inputs (JSON)', { exact: true }).click()
  await page.getByRole('textbox', { name: 'Resource instruction inputs' }).fill('{broken')
  await expect(page.getByRole('textbox', { name: 'Resource instruction inputs' })).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('textbox', { name: 'Resource instruction inputs' })).toHaveAccessibleDescription('Instruction inputs must be a valid JSON object.')
  await expect(page.getByRole('button', { name: 'Save resource defaults' })).toBeDisabled()
  expect(calls.filter(row => row.op === 'profile-resources-set')).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Resource instruction inputs' }).fill('{}')
  await expect(page.getByRole('textbox', { name: 'Resource instruction inputs' })).not.toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('button', { name: 'Save resource defaults' })).toBeEnabled()
})

test('managed MCP defaults use the same picker, required policy and review link', async ({ page }) => {
  const calls = await mock(page)
  await page.getByRole('checkbox', { name: 'fixture/default · update pending', exact: true }).press('Space')
  await page.getByRole('checkbox', { name: 'Required', exact: true }).press('Space')
  await expect(page.getByRole('link', { name: 'Review update', exact: true })).toHaveAttribute('href', '#/agents/tools?publisher=fixture&resource=default')
  await page.getByRole('button', { name: 'Save resource defaults' }).click()
  await expect(page.getByText('Resource defaults saved.', { exact: true })).toBeVisible()
  const saved = calls.find(row => row.op === 'profile-resources-set')!
  expect(saved.args.resources).toEqual({ instructions: null, skills: [], mcp: [{ target: mcpTarget, required: true }] })
})
