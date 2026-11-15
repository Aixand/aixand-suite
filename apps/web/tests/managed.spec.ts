import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type WebSocketRoute } from './fixtures'

async function fixture(page: Page, directory: string) {
  const bridge = process.env.SUITE_MANAGED_BRIDGE ?? resolve('../server/agent-bridge')
  const python = process.env.MANAGED_TEST_PYTHON ?? resolve(bridge, '../../../../manager-suites/.venv/bin/python')
  await mkdir(directory, { recursive: true })
  const work = await mkdtemp(resolve(directory, 'manager-'))
  const worker = spawn(python, ['-B', resolve('tests/managed_worker.py'), work, bridge], { stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let next = 0, stderr = '', socket: WebSocketRoute | undefined
  worker.stderr.on('data', chunk => { stderr += String(chunk) })
  createInterface({ input: worker.stdout }).on('line', line => {
    const result = JSON.parse(line)
    const pending = waiting.get(result.id); waiting.delete(result.id)
    if (result.error) pending?.reject(new Error(result.error)); else pending?.resolve(result.result)
  })
  worker.on('exit', () => { for (const pending of waiting.values()) pending.reject(new Error(stderr || 'Manager fixture exited')); waiting.clear() })
  function call<T = unknown>(op: string, args: object = {}) {
    const id = ++next
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: value => resolve(value as T), reject })
      worker.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }
  await page.routeWebSocket('**/api/agents/ws', route => {
    socket = route; route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const { id, op, args } = JSON.parse(String(raw))
      const action = op.includes('-managed-') ? call(op, args) : Promise.resolve(
        op === 'prompts-catalog' ? { store: work, packs: [], sources: [], consumers: [], applications: [], checked_at: new Date().toISOString() }
          : op === 'skills-catalog' ? { store: work, sources: [], entries: [], releases: [] }
          : op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: work }
          : op === 'sessions' ? { runs: [], runtimeError: null }
          : op === 'chat-list' ? [] : op === 'project-list' ? [] : null)
      void action.then(result => {
        route.send(JSON.stringify({ type: 'result', id, result }))
        if (op.includes('-managed-') && /-(apply|save|rollback|tracking|upload-finish)$/.test(op)) route.send(JSON.stringify({ type: `${op.split('-')[0]}-changed` }))
      }).catch(error => route.send(JSON.stringify({ type: 'error', id, code: 'conflict', message: error.message })))
    })
  })
  return {
    call,
    async update(kind: 'prompts' | 'skills') { const result = await call('fixture-update', { kind }); socket?.send(JSON.stringify({ type: `${kind}-changed` })); return result },
    async close() { worker.stdin.end(); await new Promise<void>(resolve => { if (worker.exitCode !== null) resolve(); else worker.once('exit', () => resolve()) }); await rm(work, { recursive: true, force: true }) },
  }
}

async function open(page: Page, kind: 'prompts' | 'skills') {
  await page.goto(`/#/${kind}`)
  await page.getByRole('region', { name: 'Managed library', exact: true }).getByRole('button').first().click()
  await page.locator('.managed-files').getByRole('button').first().click()
  await page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('menuitem', { name: 'body.md', exact: true }).click()
  await expect(page.getByLabel('Managed resource content', { exact: true })).toHaveText('Your saved version.')
}

for (const kind of ['prompts', 'skills'] as const) {
  test(`${kind}: keeps the accepted copy until a real manager reconciliation is applied`, async ({ page }) => {
    const backend = await fixture(page, test.info().outputPath('fixture'))
    try {
      await open(page, kind)
      if (kind === 'prompts') {
        await expect(page.getByRole('tablist')).toHaveCount(0)
        const sections = page.getByRole('group', { name: 'Prompt sections', exact: true })
        await sections.getByRole('button', { name: 'Profile assignments', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Profile assignments', exact: true })).toBeVisible()
        await sections.getByRole('button', { name: 'Library', exact: true }).click()
        await expect(page.getByLabel('Managed resource content', { exact: true })).toHaveText('Your saved version.')
      }
      await backend.update(kind)
      if (kind === 'prompts') await expect(page.getByText('Publisher update needs review. Your customized version is still active.')).toBeVisible()
      else await expect(page.getByRole('button', { name: 'Publisher update needs review. Your customized version is still active.', exact: true }).first()).toBeVisible()
      await expect(page.getByLabel('Managed resource content', { exact: true })).toHaveText('Your saved version.')
      await page.getByRole('button', { name: 'Review update', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Publisher update', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Review later', exact: true }).click()
      expect((await backend.call<{ text: string }>('fixture-content', { kind })).text).toBe('Your saved version.\n')
      await page.getByRole('button', { name: 'Review update', exact: true }).click()
      await page.getByRole('button', { name: /Choice for/ }).click()
      await page.getByRole('option', { name: 'Use publisher for this conflict', exact: true }).click()
      await page.getByRole('button', { name: 'Preview choices', exact: true }).click()
      await expect(page.getByText('0 unresolved conflict(s).')).toBeVisible()
      const accessibility = await new AxeBuilder({ page }).include('.managed-reader').analyze()
      expect(accessibility.violations).toEqual([])
      await page.getByRole('button', { name: 'Apply reconciled update', exact: true }).click()
      await expect(page.getByLabel('Managed resource content', { exact: true })).toHaveText('Publisher update 2.')
      const accepted = await backend.call<{ text: string; status: { reconciliation_required: boolean } }>('fixture-content', { kind })
      expect(accepted.text).toBe('Publisher update 2.\n')
      expect(accepted.status.reconciliation_required).toBe(false)
      await page.screenshot({ path: test.info().outputPath(`${kind}-accepted.png`) })
    } finally { await backend.close() }
  })
}

test('a newer publisher update preserves draft choices and requires a fresh review', async ({ page }) => {
  const backend = await fixture(page, test.info().outputPath('fixture'))
  try {
    await open(page, 'prompts'); await backend.update('prompts')
    await page.getByRole('button', { name: 'Review update', exact: true }).click()
    const choice = page.getByRole('button', { name: /Choice for/ })
    await choice.click()
    await page.getByRole('option', { name: 'Keep mine for this conflict', exact: true }).click()
    await backend.update('prompts')
    await expect(page.getByText('This resource changed. Your unsaved work is retained. Reload the comparison before applying.')).toBeVisible()
    await expect(choice).toContainText('Keep mine for this conflict')
    await expect(page.getByRole('button', { name: 'Apply reconciled update', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Reload current revision', exact: true }).click()
    await expect(choice).toContainText('Keep mine for this conflict')
    await page.getByRole('button', { name: 'Preview choices', exact: true }).click()
    await page.getByRole('button', { name: 'Apply reconciled update', exact: true }).click()
    const result = await backend.call<{ text: string; status: { reconciliation_required: boolean } }>('fixture-content', { kind: 'prompts' })
    expect(result.text).toBe('Your saved version.\n'); expect(result.status.reconciliation_required).toBe(false)
  } finally { await backend.close() }
})

test('uploads a binary skill asset larger than a socket message', async ({ page }) => {
  const backend = await fixture(page, test.info().outputPath('fixture'))
  try {
    await open(page, 'skills')
    await page.getByRole('button', { name: 'Resource actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Upload file', exact: true }).click()
    await page.getByRole('textbox', { name: 'File path', exact: true }).fill('assets/data.bin')
    const content = Buffer.alloc(150000, 255)
    await page.getByRole('dialog', { name: 'Upload resource file', exact: true }).locator('input[type=file]').setInputFiles({ name: 'data.bin', mimeType: 'application/octet-stream', buffer: content })
    await page.getByRole('dialog', { name: 'Upload resource file', exact: true }).getByRole('button', { name: 'Upload file', exact: true }).click()
    await expect(page.getByText('Uploaded file saved in managed copy.')).toBeVisible()
    await page.locator('.managed-files').getByRole('button').first().click()
    await page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('menuitem', { name: 'assets/data.bin', exact: true }).click()
    await expect(page.getByText('Binary file · 150000 bytes. Download it or upload a replacement.')).toBeVisible()
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download file', exact: true }).click()
    expect((await downloaded).suggestedFilename()).toBe('data.bin')
    await page.getByRole('button', { name: 'Resource actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete file', exact: true }).click()
    await page.getByRole('alertdialog', { name: 'Delete file?', exact: true }).getByRole('button', { name: 'Keep file', exact: true }).click()
    await expect(page.getByText('Binary file · 150000 bytes. Download it or upload a replacement.')).toBeVisible()
    await page.getByRole('button', { name: 'Resource actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete file', exact: true }).click()
    await page.getByRole('alertdialog', { name: 'Delete file?', exact: true }).getByRole('button', { name: 'Delete file', exact: true }).click()
    await expect(page.getByText('File removed from managed copy.', { exact: true })).toBeVisible()
    await page.locator('.managed-files').getByRole('button').first().click()
    await expect(page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('menuitem', { name: 'assets/data.bin', exact: true })).toHaveCount(0)
  } finally { await backend.close() }
})


for (const mode of ['light', 'dark'] as const) test(`managed file editing retains its draft when navigation is cancelled in ${mode}`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), mode)
  const backend = await fixture(page, test.info().outputPath('fixture'))
  try {
    await open(page, 'skills')
    if (mode === 'dark') {
      await expect(page.getByRole('button', { name: 'History', exact: true })).toBeHidden()
      await page.getByText('Versions and source', { exact: true }).click()
      await page.getByText('History and refresh', { exact: true }).click()
      await expect(page.getByRole('button', { name: 'History', exact: true })).toBeVisible()
      await page.getByText('History and refresh', { exact: true }).click()
      await page.screenshot({ path: test.info().outputPath('managed-overview-dark.png') })
    }
    await page.getByRole('button', { name: 'Edit skill', exact: true }).click()
    const editor = page.locator('.resource-editor')
    const text = editor.getByRole('textbox', { name: 'Managed file contents', exact: true })
    await text.fill('A local managed draft.')
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Keep editing', exact: true }).click()
    await expect(text).toHaveText('A local managed draft.')
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(editor).toBeHidden()
    expect((await backend.call<{ text: string }>('fixture-content', { kind: 'skills' })).text).toBe('A local managed draft.')
  } finally { await backend.close() }
})
