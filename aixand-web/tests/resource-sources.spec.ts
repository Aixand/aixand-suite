import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { test, expect, mockAuthentication, type Page } from './fixtures'

async function setup(page: Page, kind: 'skills' | 'prompts' | 'mcp') {
  await mockAuthentication(page)
  const root = await mkdtemp(resolve(tmpdir(), 'suite-sources-'))
  const worker = spawn(process.env.MANAGED_TEST_PYTHON!, ['-B', resolve('tests/resource_sources_worker.py'), root, process.env.SUITE_MANAGED_BRIDGE!], { stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let stderr = ''
  worker.stderr.on('data', value => { stderr += String(value) })
  createInterface({ input: worker.stdout }).on('line', line => { const row = JSON.parse(line); const item = pending.get(row.id); pending.delete(row.id); if (row.error) item?.reject(new Error(row.error)); else item?.resolve(row.result) })
  const call = <T,>(op: string, args: object = {}) => new Promise<T>((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); worker.stdin.write(JSON.stringify({ id: next, op, args }) + '\n') })
  await page.routeWebSocket('**/api/agents/ws', route => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const row = JSON.parse(String(raw)); if (!row.op) return
      let value: Promise<unknown> = Promise.resolve([])
      if (row.op.includes('-managed-')) value = call(row.op, row.args)
      else if (row.op === 'catalog') value = Promise.resolve({ profiles: [], auths: [], capabilities: [], cwd: root })
      else if (row.op === 'mcp-catalog') value = Promise.resolve({ servers: [] })
      else if (row.op === 'skills-catalog') value = Promise.resolve({ sources: [], entries: [], releases: [], store: root, store_id: '' })
      else if (row.op === 'prompts-catalog') value = Promise.resolve({ packs: [], consumers: [], applications: [], sourceRegistrations: [], sources: [], history: [], checked_at: Date.now() })
      else if (row.op === 'sessions') value = Promise.resolve({ runs: [], runtimeError: null })
      void value.then(result => { route.send(JSON.stringify({ type: 'result', id: row.id, result })); if (row.op.endsWith('-source-job') || /-managed-(apply|save)$/.test(row.op)) route.send(JSON.stringify({ type: `${row.op.startsWith('mcp') ? 'mcps' : row.op.split('-')[0]}-changed` })) }).catch(error => route.send(JSON.stringify({ type: 'error', id: row.id, message: error.message })))
    })
  })
  await page.goto(`/#/agents/${kind === 'mcp' ? 'tools' : kind}`)
  return { call, async close() { await page.close(); worker.stdin.end(); await new Promise<void>(resolve => { if (worker.exitCode !== null) resolve(); else worker.once('exit', () => resolve()) }); if (stderr) console.error(stderr); await rm(root, { recursive: true, force: true }) } }
}

test('create an owned prompt directly without source registration', async ({ page }) => {
  const backend = await setup(page, 'prompts')
  try {
    await page.getByRole('button', { name: 'Add prompt', exact: true }).click()
    await page.getByRole('button', { name: 'Create new', exact: true }).click()
    await page.getByLabel('Prompt name', { exact: true }).fill('review')
    await page.getByLabel('Prompt text', { exact: true }).fill('Review carefully {{ literal }}')
    await page.getByRole('button', { name: 'Create prompt', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit prompt', exact: true })).toBeVisible()
    const value = await backend.call<any>('fixture-read', { kind: 'prompts', publisher: 'local', identifier: 'review' })
    expect(value.snapshot.files['prompt.md']).toBe('Review carefully {{ literal }}')
  } finally { await backend.close() }
})

for (const mode of ['light', 'dark'] as const) test(`GitHub skill selection preserves local edits and update activity in ${mode}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
  const backend = await setup(page, 'skills')
  try {
    await page.getByRole('button', { name: 'Add skill', exact: true }).click()
    await page.getByRole('button', { name: 'Import from GitHub', exact: true }).click()
    await page.getByLabel('GitHub URL', { exact: true }).fill('https://github.com/example/resources')
    await page.getByRole('button', { name: 'Find resources', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose resources to import' })).toBeVisible()
    await page.locator('.resource-source-discovery label').filter({ has: page.getByRole('checkbox', { name: 'review', exact: true }) }).click()
    await page.getByRole('button', { name: 'Import selected resources', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit skill', exact: true })).toBeVisible()
    await page.getByText('Source and update settings', { exact: true }).click()
    await expect(page.getByText('Source and updates', { exact: true })).toBeVisible()
    const catalog = await backend.call<any>('skills-managed-list')
    expect(catalog.items).toHaveLength(1)
    const item = catalog.items[0]
    const value = await backend.call<any>('fixture-read', { kind: 'skills', publisher: item.publisher_id, identifier: item.id })
    expect(value.manifest.files.some((row: any) => row.path === 'scripts/check.py' && row.executable)).toBe(true)
    await backend.call('skills-managed-save', { publisherId: item.publisher_id, resourceId: item.id, expectedRevision: item.revision,
      files: { 'SKILL.md': { content_b64: Buffer.from('---\nname: review\ndescription: Review code\n---\n\nMy instructions').toString('base64'), executable: false } } })
    await backend.call('fixture-update')
    await page.reload()
    await page.getByText('Source and update settings', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await expect(page.getByText('Publisher update needs review. Your customized version is still active.')).toBeVisible()
    const changed = await backend.call<any>('fixture-read', { kind: 'skills', publisher: item.publisher_id, identifier: item.id })
    expect(changed.resolution.reconciliation_required).toBe(true)
    if (mode === 'dark') {
      await expect(page.getByRole('button', { name: 'Reload current revision', exact: true })).toBeVisible()
      const disclosure = page.locator('.resource-source-panel > .content-disclosure')
      if (await disclosure.getAttribute('open') !== null) await disclosure.locator(':scope > summary').click()
      await expect(page.locator('.resource-source-activity [role="status"]')).toBeVisible()
      await page.screenshot({ path: test.info().outputPath('source-activity-dark.png') })
    }
  } finally { await backend.close() }
})

test('manual MCP creation saves a managed definition', async ({ page }) => {
  const backend = await setup(page, 'mcp')
  try {
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).click()
    await page.getByRole('button', { name: 'Configure manually', exact: true }).click()
    await page.getByLabel('Server name', { exact: true }).fill('example')
    await page.getByLabel('Command', { exact: true }).fill('true')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit server', exact: true })).toBeVisible()
    const value = await backend.call<any>('fixture-read', { kind: 'mcp', publisher: 'local', identifier: 'example' })
    expect(value.definition.command).toBe('true')
  } finally { await backend.close() }
})

test('GitHub MCP import previews its launch configuration', async ({ page }) => {
  const backend = await setup(page, 'mcp')
  try {
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).click()
    await page.getByRole('button', { name: 'Import from GitHub', exact: true }).click()
    await page.getByLabel('GitHub URL', { exact: true }).fill('https://github.com/example/resources')
    await page.getByRole('button', { name: 'Find resources', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose resources to import' })).toBeVisible()
    await page.getByText('Preview package', { exact: true }).click()
    await expect(page.locator('.resource-source-discovery pre')).toContainText('publisher-1')
    await page.getByRole('button', { name: 'Import selected resources', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Edit server', exact: true })).toBeVisible()
    await page.getByText('Source and update settings', { exact: true }).click()
    await expect(page.getByText('Source and updates', { exact: true })).toBeVisible()
  } finally { await backend.close() }
})
