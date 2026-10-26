import { openChatSettings, expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ProjectDirectory, ProjectFile, ProjectFileEntry } from '../src/projects/files'
import type { ChatSnapshot } from '../src/chats/model'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secondProjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const remoteChatId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='

async function fixture(page: Page, options: { failListing?: boolean; delayRead?: boolean } = {}) {
  const operations: { op: string; args: Record<string, unknown> }[] = []
  const projects = [{ id: projectId, name: 'Studio', path: '/work/studio' },
    { id: secondProjectId, name: 'Library', path: '/work/library' }]
  const localChat: ChatSnapshot = { id: chatId, projectId, provider: 'codex', profile: 'work', auth: null,
    cwd: '/work/studio', project: 'Studio', mode: 'work', title: 'Review Studio', status: 'completed',
    revision: 1, createdAt: 1, updatedAt: 1, items: [], requests: [] }
  const remoteChat: ChatSnapshot = { ...localChat, id: remoteChatId, deviceId: 'remote-device', device: 'Other machine', title: 'Remote Studio' }
  let failListing = !!options.failListing
  let releaseRead = () => {}
  let text = '# Studio\nRead the project files here.'
  const entry = (name: string, kind: ProjectFileEntry['kind'] = 'file', path = name): ProjectFileEntry =>
    ({ name, path, kind, size: 42, modifiedAt: 1, supported: kind === 'file' || kind === 'directory' })
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { id: string; op: string; args: Record<string, unknown> }
      operations.push(message)
      let result: unknown = {}
      const args = message.args
      switch (message.op) {
        case 'catalog': result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/work' }; break
        case 'sessions': result = { runs: [], runtimeError: null }; break
        case 'agent-operations': result = { operations: [] }; break
        case 'models': case 'chat-launches': case 'mcp-jobs': result = []; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'mcp-preview': result = { selection: {}, states: [] }; break
        case 'project-list': result = projects; break
        case 'project-discovery-list': result = { jobs: [], nextOffset: null }; break
        case 'chat-list': result = [localChat, remoteChat]; break
        case 'chat-open': result = args.chatId === remoteChatId ? remoteChat : localChat; break
        case 'project-files-list': {
          if (failListing) {
            route.send(JSON.stringify({ type: 'error', id: message.id, code: 'request_failed', message: 'Project directory is temporarily unavailable.' }))
            return
          }
          let entries = args.projectId === secondProjectId ? [entry('library.ts')] : args.path === 'src' ?
            [entry('App.tsx', 'file', 'src/App.tsx')] : [entry('src', 'directory'), entry('README.md'), entry('image.png'), entry('binary.bin'), entry('large.txt'), entry('linked', 'link')]
          if (args.hidden) entries = [...entries, entry('.env')]
          const offset = Number(args.offset ?? 0)
          const pageEntries = entries.slice(offset, offset + 3)
          result = { projectId: String(args.projectId), path: String(args.path ?? ''), entries: pageEntries, total: entries.length,
            nextOffset: offset + pageEntries.length < entries.length ? offset + pageEntries.length : null, limited: false } satisfies ProjectDirectory
          break
        }
        case 'project-file-read': {
          result = { projectId: String(args.projectId), path: String(args.path), name: String(args.path).split('/').at(-1)!,
            size: 42, modifiedAt: 1, truncated: args.path === 'large.txt', kind: 'text',
            content: args.projectId === secondProjectId ? 'export const library = true' : args.path === 'src/App.tsx' ?
              'export function App() { return <main>Studio</main> }' : args.path === '.env' ? 'TEST_ONLY=true' : text } satisfies ProjectFile
          if (args.path === 'image.png') result = { ...result as ProjectFile, kind: 'image', mime: 'image/png', content: png }
          if (args.path === 'binary.bin') result = { ...result as ProjectFile, kind: 'unsupported', message: 'A preview is unavailable for this binary or non-UTF-8 file.' }
          if (options.delayRead && args.path === 'README.md') {
            releaseRead = () => route.send(JSON.stringify({ type: 'result', id: message.id, result }))
            return
          }
          break
        }
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/chat')
  return { operations, releaseRead: () => releaseRead(), allowListing: () => { failListing = false }, updateText: (value: string) => { text = value } }
}

async function selectProject(page: Page, name = 'Studio') {
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click()
  const showFiles = page.getByRole('button', { name: 'Show project files', exact: true })
  if (name !== 'No project' && await showFiles.isVisible() && await page.locator('.project-files-sidebar').count() === 0 && await page.viewportSize()!.width > 1100) await showFiles.click()
}

test('project files open on the right, browse folders, preserve drafts, and restore pane preferences', async ({ page }) => {
  await fixture(page)
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my instructions while I read')
  await selectProject(page)
  const sidebar = page.getByRole('complementary', { name: 'Project files sidebar' })
  const pane = sidebar.getByRole('region', { name: 'Project files', exact: true })
  await expect(pane.getByRole('button', { name: 'Open file README.md', exact: true })).toBeVisible()
  const chatBox = await page.locator('.command-content').boundingBox()
  const fileBox = await sidebar.boundingBox()
  expect(fileBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width - 1)
  await pane.getByRole('button', { name: 'Open folder src', exact: true }).click()
  await pane.getByRole('button', { name: 'Open file App.tsx', exact: true }).click()
  await expect(pane.getByRole('region', { name: 'File preview' })).toContainText('export function App()')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep my instructions while I read')
  await pane.getByRole('navigation', { name: 'Project folders' }).getByRole('button', { name: 'Studio', exact: true }).click()
  await pane.getByLabel('Hidden files', { exact: true }).check()
  await pane.getByRole('button', { name: 'Load more files' }).click()
  await pane.getByRole('button', { name: 'Load more files' }).click()
  await expect(pane.getByRole('button', { name: 'Open file .env', exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Open file linked', exact: true })).toBeDisabled()
  const separator = sidebar.getByRole('separator', { name: 'Resize project files' })
  await separator.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '408')
  await pane.getByRole('button', { name: 'Hide project files', exact: true }).click()
  await expect(sidebar).toHaveCount(0)
  await page.getByRole('button', { name: 'Show project files', exact: true }).click()
  await expect(separator).toHaveAttribute('aria-valuenow', '408')
  await page.reload()
  await selectProject(page)
  await expect(separator).toHaveAttribute('aria-valuenow', '408')
  await selectProject(page, 'No project')
  await expect(sidebar).toHaveCount(0)
})

test('files refresh after edits, previews handle images, binary and large files safely', async ({ page }) => {
  const state = await fixture(page)
  await selectProject(page)
  const pane = page.getByRole('region', { name: 'Project files', exact: true })
  await pane.getByRole('button', { name: 'Open file README.md', exact: true }).click()
  await expect(pane.getByRole('region', { name: 'File preview' })).toContainText('# Studio')
  state.updateText('<script>window.projectFileExecuted = true</script>\nUpdated source')
  await pane.getByRole('button', { name: 'Refresh files', exact: true }).click()
  await expect(pane.getByRole('region', { name: 'File preview' })).toContainText('Updated source')
  expect(await page.evaluate(() => 'projectFileExecuted' in window)).toBe(false)
  await pane.getByRole('button', { name: 'Open file image.png', exact: true }).click()
  await expect(pane.getByRole('img', { name: 'Preview of image.png' })).toBeVisible()
  await pane.getByRole('button', { name: 'Load more files' }).click()
  await pane.getByRole('button', { name: 'Open file binary.bin', exact: true }).click()
  await expect(pane.getByRole('region', { name: 'File preview' })).toContainText('binary or non-UTF-8')
  await pane.getByRole('button', { name: 'Open file large.txt', exact: true }).click()
  await expect(pane.getByRole('status')).toContainText('Showing the first 256 KiB')
  await pane.getByRole('button', { name: 'Close file preview', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Open file large.txt', exact: true })).toBeFocused()
})

test('switching projects discards old reads and saved project chats retain their directory', async ({ page }) => {
  const state = await fixture(page, { delayRead: true })
  await selectProject(page)
  await page.getByRole('button', { name: 'Open file README.md', exact: true }).click()
  await expect(page.getByRole('region', { name: 'File preview' })).toContainText('Reading file')
  await selectProject(page, 'Library')
  await expect(page.getByRole('button', { name: 'Open file library.ts', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open file library.ts', exact: true }).click()
  state.releaseRead()
  await expect(page.getByRole('region', { name: 'File preview' })).toContainText('export const library = true')
  await page.goto(`/#/chat/${chatId}`)
  await expect(page.getByRole('button', { name: 'Open folder src', exact: true })).toBeVisible()
  expect(state.operations.filter((operation) => operation.op === 'project-files-list').at(-1)?.args.projectId).toBe(projectId)
  await page.goto(`/#/chat/${remoteChatId}`)
  await expect(page.getByRole('group', { name: 'Remote execution location' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toHaveCount(0)
})

test('unavailable project directories show a recoverable error', async ({ page }) => {
  const state = await fixture(page, { failListing: true })
  await selectProject(page)
  const pane = page.getByRole('region', { name: 'Project files', exact: true })
  await expect(pane.getByRole('alert')).toHaveText('Project directory is temporarily unavailable.')
  state.allowListing()
  await pane.getByRole('button', { name: 'Retry files' }).click()
  await expect(pane.getByRole('button', { name: 'Open folder src', exact: true })).toBeVisible()
  await expect(pane.getByRole('alert')).toHaveCount(0)
})

test('project file drawer works on mobile and the desktop pane is accessible in both themes', async ({ page }) => {
  await fixture(page)
  await selectProject(page)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { localStorage.setItem('aixand.appearance', value) }, theme)
    await page.reload()
    await selectProject(page)
    await page.getByRole('button', { name: 'Open file README.md', exact: true }).click()
    const desktop = await new AxeBuilder({ page }).include('.project-files-sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(desktop.violations, `${theme} desktop files`).toEqual([])
    await page.screenshot({ path: `artifacts/project-files/${theme}-desktop.png` })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show project files', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Project files', exact: true })
  await drawer.getByRole('button', { name: 'Open folder src', exact: true }).click()
  await drawer.getByRole('button', { name: 'Open file App.tsx', exact: true }).click()
  await expect(drawer.getByRole('region', { name: 'File preview' })).toContainText('export function App()')
  const mobile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(mobile.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'artifacts/project-files/mobile.png' })
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show project files', exact: true })).toBeFocused()
})
