// Browser tests use a disposable Agent Manager registry and an offline provider.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, delimiter } from 'node:path'
import { buildTestServer } from './isolated-test-server.mjs'

const server = resolve('../aixand-server')
const work = mkdtempSync(resolve(tmpdir(), 'aixand-browser-agents-'))
const sdkPath = [
  resolve('../../manager-suites/agent-manager'),
  resolve('../../undercurrent/python/src'),
].join(delimiter)
const fixture = JSON.parse(
  execFileSync(
    'python3',
    [resolve(server, 'agent-bridge/tests/fixture.py'), work],
    {
      env: { ...process.env, PYTHONPATH: sdkPath },
      encoding: 'utf8',
    },
  ),
)
const child = spawn(process.execPath, [buildTestServer(server, work)], {
  cwd: server,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENTS_PYTHON: 'python3',
    AGENTS_MANAGER_SOURCE: resolve('../../manager-suites/agent-manager'),
    AGENTS_RUNTIME_SOURCE: resolve('../../undercurrent/python/src'),
    AGENT_MANAGER_HOME: fixture.home,
    AGENT_MANAGER_CONFIG: fixture.config,
    AGENTS_CWD: work,
    AGENTS_STATE_DIR: resolve(work, 'chats'),
    AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
    CARRIER_AUTO_PROVISION: '0',
    CARRIER_URL: 'http://127.0.0.1:1',
    CARRIER_STATE_DIR: resolve(work, 'carrier-suite'),
    CARRIER_STATE_DATABASE: resolve(work, 'carrier-suite/suite.db'),
    CARRIER_DATABASE: resolve(work, 'carrier.db'),
    CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'),
    CARRIER_MAILBOXES_FILE: '',
    CARRIER_AGENT_CONFIG: '',
    UNDERCURRENT_HOME: resolve(work, 'undercurrent'),
    UNDERCURRENT_PYTHON_BRIDGE: resolve(
      '../../undercurrent/target/debug/uc-python-bridge',
    ),
  },
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => child.kill(signal))
child.once('exit', (code) => {
  rmSync(work, { recursive: true, force: true })
  process.exit(code ?? 0)
})
