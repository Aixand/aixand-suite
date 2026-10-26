// Browser -> Nest -> real Manager/runtime/registry, entirely disposable local providers.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import { buildTestServer, testAuthEnvironment } from './isolated-test-server.mjs'
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..'), server = resolve(web, '../aixand-server')
const work = await mkdtemp(resolve(tmpdir(), 'suite-onboarding-live-'))
const binaries = resolve(web, '../../undercurrent/target/debug')
const python = process.env.AGENTS_TEST_PYTHON ?? resolve(web, '../aixand-ir/.venv/bin/python')
const installPrefix = resolve(work, 'npm'), installTools = resolve(work, 'install-tools')
const env = { ...process.env, HOME: resolve(work, 'user'),
  PATH: [installTools, resolve(installPrefix, 'bin'), binaries, '/usr/bin', '/bin'].join(delimiter),
  AGENTS_PYTHON: python, AGENT_MANAGER_HOME: resolve(work, 'manager'), AGENT_MANAGER_CONFIG: resolve(work, 'providers.toml'),
  AGENTS_CWD: resolve(work, 'projects'), AGENTS_STATE_DIR: resolve(work, 'state'), AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
  UNDERCURRENT_HOME: resolve(work, 'runtime'), UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
  XDG_STATE_HOME: resolve(work, 'xdg-state'),
  CARRIER_AUTO_PROVISION: '0', CARRIER_URL: 'http://127.0.0.1:1', CARRIER_DATABASE: resolve(work, 'carrier.db'),
  CARRIER_STATE_DIR: resolve(work, 'carrier'), CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'),
  PROMPT_MANAGER_HOME: resolve(work, 'prompts'), SKILL_MANAGER_HOME: resolve(work, 'skills'), MCP_MANAGER_HOME: resolve(work, 'mcp'),
}
const children = [], logs = []
let browser, backend, failed = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...testAuthEnvironment(), ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value).slice(-8000) })
  child.on('error', error => { output += error.message }); children.push(child); logs.push(() => output); return child
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM')
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 10000)
  await exited; clearTimeout(timer)
}
async function port() {
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done)); const value = socket.address().port
  await new Promise(done => socket.close(done)); return value
}
async function ready(url) {
  await expect.poll(async () => { try { return (await fetch(url)).ok } catch { return false } }, { timeout: 30000 }).toBe(true)
}
try {
  await mkdir(resolve(work, 'projects/website/src'), { recursive: true }); await mkdir(resolve(work, 'projects/api'), { recursive: true })
  await mkdir(installTools); await mkdir(env.HOME)
  await writeFile(resolve(installTools, 'node'), `#!${python}\nprint('v24.0.0')\n`, { mode: 0o700 })
  await writeFile(resolve(installTools, 'npm'), `#!${python}
import pathlib, sys, time
root = pathlib.Path(${JSON.stringify(work)})
prefix = root / 'npm'
if sys.argv[1:] == ['prefix', '-g']:
    print(prefix)
elif sys.argv[1:] == ['install', '-g', '@openai/codex@latest']:
    with (root / 'install-count').open('a') as stream: stream.write('install\\n')
    deadline = time.monotonic() + 90
    while not (root / 'finish-install').exists():
        if time.monotonic() > deadline: sys.exit(2)
        time.sleep(.1)
    target = prefix / 'lib/node_modules/@openai/codex/bin/codex'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('#!' + sys.executable + '\\nprint("codex 1.2.3")\\n')
    target.chmod(0o700)
    entry = prefix / 'bin/codex'
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.symlink_to(target)
else:
    sys.exit(1)
`, { mode: 0o700 })
  const executable = resolve(work, 'example-agent')
  await writeFile(executable, `#!${python}\nimport sys\nif '--version' in sys.argv: print('example 1.2.3')\nelif 'login' in sys.argv: print('Local fixture login completed')\nelse:\n print('EXAMPLE_READY', flush=True)\n for line in sys.stdin: print('EXAMPLE_REPLY', flush=True)\n`, { mode: 0o700 })
  const definitions = ['codex', 'opencode', 'claude', 'antigravity', 'gemini', 'copilot'].map(provider =>
    `[providers.${provider}]\nexecutable = ${JSON.stringify(provider === 'codex' ? resolve(installPrefix, 'bin/codex') : resolve(work, 'missing-' + provider))}\nnative_home = ${JSON.stringify(resolve(work, 'native-' + provider))}\n`)
  definitions.push(`[providers.example]\nlabel = "Example Agent"\nexecutable = ${JSON.stringify(executable)}\nnative_home = ${JSON.stringify(resolve(work, 'native-example'))}\nhome_env = "EXAMPLE_HOME"\nauth_mode = "native"\nlogin_args = ["login"]\n`)
  await writeFile(env.AGENT_MANAGER_CONFIG, definitions.join('\n'))
  process.env.AIXAND_TEST_SETUP_PENDING = '1' 
  const main = buildTestServer(server, work)
  const apiPort = await port(), webPort = await port(), origin = `http://127.0.0.1:${webPort}`
  start(resolve(binaries, 'uc-daemon'), [], work)
  await expect.poll(() => spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], { env, timeout: 2000 }).status, { timeout: 20000 }).toBe(0)
  const launch = () => start(process.execPath, [main], server, { HOST: '127.0.0.1', PORT: String(apiPort), CORS_ORIGINS: origin })
  backend = launch(); await ready(`http://127.0.0.1:${apiPort}/api/health`)
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` }); await ready(origin)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(30000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.getByLabel('Password', { exact: true }).fill('isolated onboarding password 9274!')
  await page.getByLabel('Confirm password', { exact: true }).fill('isolated onboarding password 9274!')
  await page.getByRole('button', { name: 'Create password', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Example Agent', exact: true })).toBeChecked({ timeout: 30000 })
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).press('Space')
  await page.getByRole('button', { name: /^Continue with 2 agents$/ }).click()
  await page.getByRole('navigation', { name: 'Selected agents' }).getByRole('button', { name: /^Codex / }).click()
  await page.getByRole('button', { name: /Installation method$/ }).click()
  await page.getByRole('option', { name: 'npm', exact: true }).click()
  await page.getByRole('button', { name: 'Install Codex', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Install automatically', exact: true }).click()
  const installing = page.getByRole('progressbar', { name: 'Running installer', exact: true })
  await expect(installing).toBeVisible()
  await expect(installing).not.toHaveAttribute('aria-valuenow')
  await expect(page.getByText('1 of 3 installation steps complete', { exact: true })).toBeVisible()
  await stop(backend); backend = launch(); await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await page.reload()
  await expect(installing).toBeVisible()
  await writeFile(resolve(work, 'finish-install'), 'continue')
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Installation', exact: true }).click()
  const installation = page.getByRole('region', { name: 'Codex installation', exact: true })
  await installation.getByText('Installation details', { exact: true }).click()
  await expect(installation.getByRole('progressbar', { name: 'Installation verified', exact: true })).toHaveAttribute('aria-valuenow', '1')
  expect(await readFile(resolve(work, 'install-count'), 'utf8')).toBe('install\n')
  await page.getByRole('button', { name: 'Set up Codex later', exact: true }).click()
  await page.getByRole('navigation', { name: 'Selected agents' }).getByRole('button', { name: /^Example Agent / }).click()
  await page.getByRole('button', { name: 'Create profile and sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Use unverified profile', exact: true })).toBeEnabled({ timeout: 30000 })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Add your initial projects', exact: true })).toBeVisible({ timeout: 30000 })
  await page.getByRole('checkbox', { name: 'Include website', exact: true }).press('Space')
  await page.getByLabel(`Project name for ${resolve(work, 'projects/website')}`, { exact: true }).fill('My website')
  await page.getByRole('checkbox', { name: 'Include api', exact: true }).press('Space')
  await page.keyboard.press('Escape')
  await expect(page.getByText('Your agents are ready. Add your initial projects or skip this step.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Choose projects', exact: true }).click()
  await expect(page.getByLabel(`Project name for ${resolve(work, 'projects/website')}`, { exact: true })).toHaveValue('My website')
  await expect(page.getByRole('checkbox', { name: 'Include api', exact: true })).toBeChecked()
  await expect.poll(async () => (await (await page.request.get(origin + '/api/auth/onboarding')).json()).projects?.entries.length).toBe(2)
  await stop(backend); backend = launch(); await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await page.reload()
  await expect(page.getByLabel(`Project name for ${resolve(work, 'projects/website')}`, { exact: true })).toHaveValue('My website', { timeout: 30000 })
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get(origin + '/api/auth/onboarding')).json()).status, { timeout: 30000 }).toBe('complete')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Add your initial projects', exact: true })).not.toBeVisible()
  const progress = await (await page.request.get(origin + '/api/auth/onboarding')).json()
  expect(progress.projects.entries.every(row => row.projectId)).toBe(true)
  const before = JSON.parse(await readFile(resolve(work, 'manager/example/state.json'), 'utf8'))
  expect(before.agents).toHaveProperty('work')
  // Reproduce an older pending wizard in an already configured workspace.
  const session = await (await page.request.get(origin + '/api/auth/session')).json()
  const stale = await page.request.post(origin + '/api/auth/onboarding', { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken },
    data: { expectedRevision: progress.revision, progress: { status: 'pending', step: 'providers', selected: [], selectionInitialized: false, current: null, drafts: {} } } })
  expect(stale.ok()).toBe(true)
  await page.reload()
  await expect.poll(async () => (await (await page.request.get(origin + '/api/auth/onboarding')).json()).status).toBe('complete')
  await expect(page.getByRole('heading', { name: 'Set up your agents', exact: true })).not.toBeVisible()
  // Manual setup stays available, automatically reusing the ready profile.
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Set up workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add your initial projects', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect.poll(async () => (await (await page.request.get(origin + '/api/auth/onboarding')).json()).status).toBe('complete')
  const after = JSON.parse(await readFile(resolve(work, 'manager/example/state.json'), 'utf8'))
  expect(after.agents).toEqual(before.agents)
  expect(after.native_login_receipts).toEqual(before.native_login_receipts)
  expect(errors).toEqual([])
  console.log('PASS: installation stage progress survives backend restart without replay, verified completion, real sign-in and profile, automatic profile reuse, project resume, registration, stale onboarding reconciliation, manual setup, no repeated sign-in.')
} catch (error) {
  failed = true
  console.error(error)
  for (const log of logs) console.error(log())
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: resolve(web, 'artifacts/onboarding/live-failure.png'), fullPage: true }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-8000))
  }
} finally {
  await browser?.close()
  for (const child of children.reverse()) await stop(child)
  await rm(work, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
