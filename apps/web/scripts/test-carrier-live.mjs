import { buildTestServer, testAuthEnvironment } from './isolated-test-server.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'

const root = mkdtempSync(join(tmpdir(), 'aixand-carrier-browser-'))
const python =
  process.env.CARRIER_TEST_PYTHON ??
  resolve('../../sdks/python/.venv/bin/python')
const binaries =
  process.env.UC_TEST_BIN ?? resolve('../../../undercurrent/target/debug')
const backend = resolve('../server')
const backendMain = buildTestServer(backend, root)
const children = []
async function unusedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}
function start(command, args, env, cwd = process.cwd(), quiet = false) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env, ...testAuthEnvironment() },
    stdio: quiet ? 'ignore' : 'inherit',
  })
  children.push(child)
  return child
}
async function finished(child) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', (code) => done(code ?? 1))
  })
}
async function healthy(url) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('Service did not become ready: ' + url)
}
let code = 1
try {
  execFileSync('npm', ['run', 'build'], { cwd: backend, stdio: 'inherit' })
  execFileSync(
    python,
    [
      join(backend, 'carrier-bridge/runtime_fixture.py'),
      'setup',
      root,
      binaries,
    ],
    { stdio: 'inherit' },
  )
  const carrierPort = await unusedPort(),
    serverPort = await unusedPort(),
    webPort = await unusedPort()
  for (const address of ['suite/local/user', 'peer'])
    execFileSync(
      python,
      [
        '-m',
        'carrier.cli',
        'session',
        address,
        '--db',
        join(root, 'carrier.db'),
        '--credentials',
        join(root, address === 'peer' ? 'peer.json' : 'user.json'),
      ],
      { stdio: 'ignore' },
    )
  const upstream = `http://127.0.0.1:${carrierPort}`
  start(
    python,
    [
      '-m',
      'carrier.cli',
      'serve',
      '--db',
      join(root, 'carrier.db'),
      '--port',
      String(carrierPort),
    ],
    {},
    process.cwd(),
    true,
  )
  start(join(binaries, 'uc-daemon'), [], {
    UNDERCURRENT_HOME: join(root, 'runtime'),
  })
  await healthy(upstream + '/health')
  const server = `http://127.0.0.1:${serverPort}`,
    web = `http://127.0.0.1:${webPort}`
  start(
    process.execPath,
    [backendMain],
    {
      HOST: '127.0.0.1',
      PORT: String(serverPort),
      CORS_ORIGINS: web,
      CARRIER_PYTHON: python,
      CARRIER_URL: upstream,
      CARRIER_DATABASE: join(root, 'carrier.db'),
      CARRIER_STATE_DIR: join(root, 'state'),
      CARRIER_USER_CREDENTIALS: join(root, 'user.json'),
      CARRIER_AUTO_PROVISION: '0',
      CARRIER_POLL_INTERVAL: '0.1',
      CARRIER_AGENT_CONFIG: join(root, 'agent-config.json'),
      AGENT_MANAGER_HOME: join(root, 'agents'),
      AGENT_MANAGER_CONFIG: join(root, 'providers.toml'),
      UNDERCURRENT_HOME: join(root, 'runtime'),
      UNDERCURRENT_PYTHON_BRIDGE: join(binaries, 'uc-python-bridge'),
    },
    backend,
  )
  await healthy(server + '/api/health')
  start(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    { AIXAND_SERVER_URL: server },
  )
  await healthy(web)
  code = await finished(
    start(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        '--config',
        'playwright.carrier.config.ts',
        ...process.argv.slice(2),
      ],
      {
        AIXAND_CARRIER_BASE_URL: web,
        AIXAND_CARRIER_TEST_ROOT: root,
        AIXAND_CARRIER_SERVICE_URL: upstream,
      },
    ),
  )
} finally {
  // Stop only fixture sessions in the disposable runtime before its daemon.
  try {
    execFileSync(
      python,
      [
        join(backend, 'carrier-bridge/runtime_fixture.py'),
        'stop',
        root,
        binaries,
      ],
      { timeout: 15_000, stdio: 'ignore' },
    )
  } catch {}
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await finished(child)
    clearTimeout(timer)
  }
  rmSync(root, { recursive: true, force: true })
}
process.exitCode = code
