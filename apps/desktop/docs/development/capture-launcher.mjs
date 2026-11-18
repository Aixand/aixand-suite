import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const root = path.resolve(option('--source-root') ?? fileURLToPath(new URL('../../../../', import.meta.url)))
const output = path.resolve(option('--output') ?? path.join(root, 'apps/desktop/docs/assets/screenshots'))
const { chromium, expect } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test')
const browser = await chromium.launch()
const captures = []
try {
  await mkdir(output, { recursive: true })
  for (const role of ['desktop', 'client']) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(/^https?:/, route => route.abort())
    await page.addInitScript(role => {
      window.__TAURI__ = {
        event: { listen: async () => () => {} },
        core: { invoke: async (command, args = {}) => {
          if (command === 'cleanup_context') return { uninstall: false, desktopSelected: false }
          if (command === 'connection_settings') return {
            profiles: role === 'desktop' ? [] : [{ id: 'studio', name: 'Studio Server', address: 'https://studio.example.test', local: false }],
            selectedId: role === 'desktop' ? '' : 'studio', autoConnect: false,
          }
          if (command === 'local_runtime_info') return { role, available: role === 'desktop' }
          if (command === 'local_runtime_setup' && args.action === 'info') return { selectionRequired: false, setupMode: 'isolated' }
          if (command === 'local_runtime_setup' && args.action === 'discover') return { found: false, tools: [], data: [] }
          if (['application_updates', 'component_updates'].includes(command) && ['status', 'due'].includes(args.action)) return { available: false, daily: true, automaticDownload: false, phase: 'disabled', message: 'Update feeds are disabled in this documentation fixture.', candidates: {}, requested: [] }
          throw new Error('Documentation fixture refuses native action: ' + command)
        } },
      }
    }, role)
    await page.goto(pathToFileURL(path.join(root, 'apps/desktop/src-tauri/launcher/index.html')).href)
    await expect(page.getByRole('heading', { name: 'Open your workspace', exact: true })).toBeVisible()
    if (role === 'desktop') {
      await expect(page.getByRole('heading', { name: 'Local workspace', exact: true })).toBeVisible()
      await expect(page.locator('#setup-message')).toContainText('Tools and component data belong to this Suite workspace.')
    } else {
      await expect(page.locator('#server-address')).toHaveValue('https://studio.example.test')
      await expect(page.locator('#client-maintenance')).toBeVisible()
    }
    await page.evaluate(() => document.fonts.ready)
    expect(errors).toEqual([])
    const name = role + '-launcher.png'
    await page.screenshot({ path: path.join(output, name), animations: 'disabled' })
    captures.push(name)
    await page.close()
  }
  const sourceHashes = {}
  for (const file of ['apps/desktop/src-tauri/launcher/index.html', 'apps/desktop/src-tauri/launcher/launcher.js', 'apps/desktop/src-tauri/launcher/launcher.css']) {
    sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  }
  await writeFile(path.join(output, 'capture.json'), JSON.stringify({ schema: 1, mode: 'real-launcher-assets-with-mocked-native-responses', viewport: { width: 1024, height: 900 }, theme: 'light', command: 'node apps/desktop/docs/development/capture-launcher.mjs', screenshots: captures, sourceHashes, limitations: 'Browser rendering of real launcher HTML/CSS/JS; no native window, service, connection, installation or update action executed. HTTPS network requests blocked. Server address is fixture data.' }, null, 2) + '\n')
  console.log('Captured Desktop and Client launcher fixtures; no native actions executed.')
} finally { await browser.close() }
