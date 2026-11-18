// Start Web on 127.0.0.1:5347, then run this script from the Suite root.
// Real builder with an authored draft and fixture authentication; no execution.
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const { chromium, expect } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test')
const output = path.join(root, 'docs/assets/screenshots/examples')
const examples = JSON.parse(await readFile(path.join(root, 'scripts/docs/example-workflows.json'), 'utf8'))
const drafts = examples.map(example => ({
  format: 'aixand.workflow-canvas', version: 1, name: example.name,
  description: 'Authored documentation illustration. Execution and supervision state are not shown.',
  nodes: example.steps.map((step, index) => ({ id: step.id, type: 'workflowStep', position: { x: index * 280, y: 0 },
    data: { kind: 'chat', label: step.label, prompt: `See the ${example.id} example for this stage's instructions.`,
      description: step.depends_on.length ? 'Uses prerequisite reports.' : 'Independent starting task.', agent: '' } })),
  edges: example.steps.flatMap(step => step.depends_on.map(source => ({ id: `${source}-${step.id}`, source, target: step.id,
    sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' }))),
}))
const browser = await chromium.launch()
try {
  await mkdir(output, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript(({ drafts, examples }) => {
    localStorage.setItem('aixand.appearance', 'light')
    localStorage.setItem('aixand.workflow.library.v1', JSON.stringify({ format: 'aixand.workflow-library', version: 1,
      workflows: drafts.map((draft, index) => ({ id: 'docs-' + examples[index].id,
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', draft })) }))
  }, { drafts, examples })
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const values = { '/api/capabilities': { voice: false, vox: false }, '/api/auth/onboarding/status': { needed: false },
      '/api/auth/installation/status': { available: false, ready: true }, '/api/auth/session': { authenticated: true, csrfToken: 'docs-fixture', expiresAt: 4102444800000 }, '/api/auth/status': { state: 'configured' } }
    return route.fulfill({ status: pathname in values ? 200 : 503, json: values[pathname] ?? { error: 'Capture blocks live API requests' } })
  })
  await page.routeWebSocket(/\/api\//, socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.op === 'auth') { socket.send(JSON.stringify({ type: 'ready' })); return }
      if (command.op === 'ack') return
      const result = command.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace/orchestration-demo' }
        : command.op === 'snapshot' ? { status: { connected: true }, messages: [], counts: {}, total: 0, next_offset: null }
          : command.op === 'sessions' ? { runs: [], runtimeError: null } : []
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  const screenshots = []
  for (const [index, example] of examples.entries()) {
    await page.goto('http://127.0.0.1:5347/#/workflows/docs-' + example.id)
    await expect(page.getByRole('region', { name: 'Workflow canvas', exact: true })).toBeVisible()
    await expect(page.locator('.react-flow__node')).toHaveCount(drafts[index].nodes.length)
    await expect(page.locator('.react-flow__edge')).toHaveCount(drafts[index].edges.length)
    await page.getByRole('button', { name: 'Arrange', exact: true }).click()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)
    const filename = example.id + '-workflow.png'
    await page.screenshot({ path: path.join(output, filename), animations: 'disabled' })
    screenshots.push(filename)
  }
  const hashes = {}
  for (const file of ['apps/web/src/pages/WorkflowBuilder.tsx', 'apps/web/src/workflows/builder/model.ts', 'scripts/docs/example-workflows.json'])
    hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  await writeFile(path.join(output, 'capture.json'), JSON.stringify({ schema: 1, mode: 'real-ui-with-authored-draft-and-fixture-auth',
    execution: 'not-run', command: 'node scripts/docs/capture-example-workflow.mjs', viewport: { width: 1600, height: 1100 }, screenshots, sourceHashes: hashes, drafts }, null, 2) + '\n')
  console.log('Captured five authored workflow graphs in real builder. No workflow or model executed.')
} finally { await browser.close() }
