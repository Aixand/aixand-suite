// Verify packaged manager homes and rejected plans with temporary data.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nodePath, pythonPath, binary } from './platform.mjs'

const execute = promisify(execFile), root = resolve(process.argv[2])
const directory = await realpath(await mkdtemp(join(tmpdir(), 'aixand-homes-')))
const home = join(directory, 'h'), base = join(directory, 's'), prefix = join(home, 'products')
await mkdir(home)
const env = { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local'),
  APPDATA: join(home, 'roaming'), TEMP: directory, TMP: directory,
  ...(process.platform === 'darwin' ? { TMPDIR: '/tmp' } : {}),
  XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CONFIG_HOME: join(home, 'config'),
  AIXAND_LOCAL_HOME: base, AIXAND_SHARED_PRODUCT_PREFIX: prefix, UNDERCURRENT_HOME: join(home, 'uc'),
  AIXAND_SKIP_PATH_REGISTRATION: '1', PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
for (const key of Object.keys(env)) if (key.endsWith('_MANAGER_HOME') || ['AGENT_MANAGER_CONFIG', 'AGENT_MANAGER_HOMES_ROOT', 'CONVERSATION_MANAGER_CONFIG', 'AIXAND_MANAGER_ROOT', 'AIXAND_SETUP_USER_ENV', 'ORCHESTRATION_HOME'].includes(key)) delete env[key]
const run = async (program, args, input = env) => (await execute(program, args, { env: input, cwd: root, windowsHide: true, timeout: 30 * 60000, maxBuffer: 4 * 1024 * 1024 })).stdout
const runtime = async (...args) => JSON.parse(await run(nodePath(root), [join(root, 'runtime.mjs'), ...args]))
const config = async input => JSON.parse(await run(nodePath(root), ['--input-type=module', '-e',
  'const {configuration}=await import(process.argv[1]);console.log(JSON.stringify(configuration(process.argv[2],process.env)))', pathToFileURL(join(root, 'runtime.mjs')).href, root], input))
const probe = `import json
from agent_manager._paths import state_root, managed_homes_root
from agent_manager.providers.paths import configuration_path
from conversation_manager.config import path, state_home
from mcp_manager import Manager as Mcp
from prompt_manager import Manager as Prompt
from skill_manager import Manager as Skill
print(json.dumps(dict(agent=str(state_root()),accounts=str(managed_homes_root()),agentConfig=str(configuration_path()),
conversation=str(state_home()),conversationConfig=str(path()),mcp=str(Mcp().home),prompt=str(Prompt().store.home),skill=str(Skill().home))))`
let daemon = false
try {
  const nativeRoot = join(home, 'data/aixand/manager')
  const expected = { agent: join(nativeRoot, 'agent/state'), accounts: join(nativeRoot, 'agent/home'), agentConfig: join(nativeRoot, 'agent/providers.toml'),
    conversation: join(nativeRoot, 'conversation/state'), conversationConfig: join(nativeRoot, 'conversation/config.toml'),
    mcp: join(nativeRoot, 'mcp'), prompt: join(nativeRoot, 'prompt'), skill: join(nativeRoot, 'skill') }
  assert.deepEqual(JSON.parse(await run(pythonPath(join(root, 'python')), ['-I', '-B', '-c', probe])), expected)
  const plan = await runtime('setup', 'choose', JSON.stringify({ mode: 'shared' }))
  const fresh = await config(env)
  assert.deepEqual(JSON.parse(await run(fresh.tools.python, ['-I', '-B', '-c', probe], fresh.env)), expected)
  const conversationConfig = join(home, 'conversation.toml'), conversationHome = join(home, 'configured-conversations')
  await writeFile(conversationConfig, '[storage]\nhome = ' + JSON.stringify(conversationHome) + '\n')
  const customEnv = { ...env, AIXAND_LOCAL_HOME: join(directory, 'custom'), AIXAND_MANAGER_ROOT: join(home, 'custom-managers'),
    MCP_MANAGER_HOME: join(home, 'custom-mcp'), CONVERSATION_MANAGER_CONFIG: conversationConfig }
  await run(nodePath(root), [join(root, 'runtime.mjs'), 'setup', 'choose', JSON.stringify({ mode: 'shared' })], customEnv)
  const custom = await config(customEnv)
  assert.equal(custom.env.AIXAND_MANAGER_ROOT, customEnv.AIXAND_MANAGER_ROOT)
  assert.equal(custom.env.AGENT_MANAGER_HOME, join(customEnv.AIXAND_MANAGER_ROOT, 'agent/state'))
  assert.equal(custom.env.MCP_MANAGER_HOME, customEnv.MCP_MANAGER_HOME)
  assert.equal(custom.env.CONVERSATION_MANAGER_HOME, conversationHome)

  const file = join(base, 'config/installation-plan.json')
  assert.equal(plan.schema, 2)
  const rejected = JSON.stringify({ ...plan, schema: 1 })
  await writeFile(file, rejected)
  await assert.rejects(config(env), /Invalid saved installation plan/)
  assert.equal(await readFile(file, 'utf8'), rejected)
  await writeFile(file, JSON.stringify(plan))
  const products = await runtime('setup', 'products')
  assert.equal((await runtime('setup', 'install', JSON.stringify({ acceptedLicenses: products.licenses.map(item => item.sha256) }))).ready, true)
  await run(nodePath(root), [join(root, 'runtime.mjs'), 'exec', 'conversation-manager', '--help'])
  const current = await config(env)
  const preserved = JSON.parse(await run(current.tools.python, ['-I', '-B', '-c', probe], current.env))
  assert.equal(preserved.accounts, expected.accounts)
  assert.equal(preserved.agent, expected.agent)
  assert.equal((await run(current.tools.python, ['-I', '-B', '-c', 'from conversation_manager import Client; print(Client().store.home)'], current.env)).trim(), current.env.CONVERSATION_MANAGER_HOME)
  const receipt = JSON.parse(await readFile(join(prefix, 'installation-receipt.json'), 'utf8'))
  const independent = [
    ['agent-manager', 'from agent_manager._paths import state_root; print(state_root())', expected.agent],
    ['mcp-manager', 'from mcp_manager import Manager; print(Manager().home)', expected.mcp],
    ['prompt-manager', 'from prompt_manager import Manager; print(Manager().store.home)', expected.prompt],
    ['skill-manager', 'from skill_manager import Manager; print(Manager().home)', expected.skill],
    ['conversation-manager', 'from conversation_manager.config import state_home; print(state_home())', expected.conversation],
  ]
  for (const [name, code, path] of independent)
    assert.equal((await run(receipt.products['manager-suite/' + name].python, ['-I', '-B', '-c', code])).trim(), path)
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  console.log(JSON.stringify({ verified: true, build: manifest.build, filesMoved: false,
    checks: ['packaged SDK defaults', 'Shared mode defaults', 'common root and product overrides', 'schema-2 plan', 'unsupported schema rejected without writes',
      'managed account homes preserved', 'independent manager product defaults'] }))
} finally {
  if (daemon) await run(join(root, 'bin', binary('uc')), ['--json', 'daemon', 'stop']).catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
