// Start the loopback fixture server from docs/development/documentation.md.
// node scripts/docs/capture-updates.mjs
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const { chromium, expect } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test')
const output = path.join(root, 'docs/assets/screenshots/updates')
const browser = await chromium.launch()
const captures = [], actions = []
let downloaded = false
try {
 await mkdir(output, { recursive: true })
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' })
 await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'light'))
 await page.route('**/api/**', async route => {
  const request = route.request(), pathname = new URL(request.url()).pathname
  const auth = { '/api/capabilities': { voice: false, vox: false }, '/api/auth/onboarding/status': { needed: false },
   '/api/auth/installation/status': { available: false, ready: true }, '/api/auth/session': { authenticated: true, csrfToken: 'docs-fixture', expiresAt: 4102444800000 }, '/api/auth/status': { state: 'configured' } }
  let result = auth[pathname]
  if (pathname.startsWith('/api/updates')) {
   if (request.method() === 'POST') {
    const input = request.postDataJSON(); actions.push({ endpoint: pathname, ...input })
    if (input.action === 'install') throw new Error('Documentation capture must never request installation')
    if (input.action === 'download') downloaded = true
    if (input.action === 'plan') {
     result = { revision: 'b'.repeat(64), ready: downloaded, requested: ['agent-manager'], shared: true,
      candidates: { 'agent-manager': { version: '0.1.1-beta' }, 'prompt-manager': { version: '0.1.1-beta' } },
      blockers: [], unsupported: [], restartRequired: true, licenses: [{ product: 'Agent Manager', text: 'Example license text for documentation screenshots only.', sha256: 'c'.repeat(64) }] }
    }
   }
   if (!result) {
    const common = { available: true, checkedAt: 1794898800000, daily: true, automaticDownload: false, host: { name: 'studio-server' } }
    result = pathname.endsWith('/products') ? { ...common, phase: downloaded ? 'downloaded' : 'available', requested: ['agent-manager'],
     inventory: { products: { 'agent-manager': { name: 'Agent Manager', version: '0.1.0-beta', scope: 'shared' }, 'prompt-manager': { name: 'Prompt Manager', version: '0.1.0-beta', scope: 'shared' }, runner: { name: 'Runner', version: '0.1.0-alpha.2', scope: 'private' } } },
     candidates: { 'agent-manager': { version: '0.1.1-beta' } } } : pathname.endsWith('/application') ? { ...common, phase: 'available', updateAvailable: false,
      installed: { role: 'server', version: '0.1.0-alpha.3' } } : { ...common, phase: 'available', inventory: { components: { server: { name: 'Server', version: '0.1.0-alpha.3' }, web: { name: 'Web interface', version: '0.1.0-alpha.3' } } }, candidates: {} }
   }
  }
  await route.fulfill({ status: result ? 200 : 503, json: result ?? { error: 'Capture blocks live API traffic' } })
 })
 await page.routeWebSocket(/\/api\//, socket => {
  socket.send(JSON.stringify({ type: 'ready' }))
  socket.onMessage(raw => {
   const command = JSON.parse(String(raw))
   const result = command.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' } : command.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : []
   socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
  })
 })
 async function capture(name, locator = page) {
  await page.evaluate(() => document.fonts.ready)
  await locator.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' }); captures.push(name + '.png')
 }
 await page.goto('http://127.0.0.1:5347/#/settings?section=updates')
 await expect(page.getByRole('heading', { name: 'Installed tool updates', exact: true })).toBeVisible()
 await page.getByRole('button', { name: 'Check all updates', exact: true }).click()
 await expect(page.locator('.settings-updates-overview')).toContainText('1 update available')
 await capture('overview')
 await page.getByRole('button', { name: 'Review tool updates', exact: true }).click()
 await expect(page.getByRole('region', { name: 'Review tool updates', exact: true })).toContainText('Prompt Manager: 0.1.1-beta (companion update)')
 await expect(page.getByRole('button', { name: 'Install selected tool updates', exact: true })).toBeDisabled()
 await page.getByRole('button', { name: 'Download selected tool updates', exact: true }).click()
 await page.getByRole('button', { name: 'Review tool updates', exact: true }).click()
 const group = page.locator('.settings-update-group').filter({ has: page.getByRole('heading', { name: 'Installed tool updates', exact: true }) })
 await capture('review-tools', group)
 await page.getByRole('switch', { name: 'I agree to the displayed tool licenses and companion updates', exact: true }).check()
 await expect(page.getByRole('button', { name: 'Install selected tool updates', exact: true })).toBeDisabled()
 await page.getByRole('switch', { name: 'I approve the reviewed tool restart impact', exact: true }).check()
 await expect(page.getByRole('button', { name: 'Install selected tool updates', exact: true })).toBeEnabled()
 if (actions.some(action => action.action === 'install')) throw new Error('Unexpected installation request')
 const source = 'apps/web/src/settings/UpdatesSettings.tsx'
 await writeFile(path.join(output, 'capture.json'), JSON.stringify({ schema: 1, mode: 'real-ui-with-fixture-data', versions: 'illustrative only', viewport: { width: 1440, height: 1000 }, theme: 'light', command: 'node scripts/docs/capture-updates.mjs', screenshots: captures,
  sourceHashes: { [source]: createHash('sha256').update(await readFile(path.join(root, source))).digest('hex') } }, null, 2) + '\n')
 console.log('Captured update overview and tool review. Checked both consent controls; no installation requested.')
} finally { await browser.close() }
