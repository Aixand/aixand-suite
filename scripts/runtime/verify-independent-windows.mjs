// Run using the independently installed Node after both runtime integrations.
// Relocate the entire application payload while testing the ordinary commands.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'win32')
const execute = promisify(execFile)
const [root, prefix, cliDirectory] = process.argv.slice(2).map(value => resolve(value))
const directory = await mkdtemp(join(tmpdir(), 'aixand-independent-'))
const home = join(directory, 'home')
await mkdir(home)
const env = { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
  HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), TEMP: directory, TMP: directory,
  PATH: [cliDirectory, join(prefix, 'python'), join(envRoot(), 'System32')].join(delimiter),
  UNDERCURRENT_HOME: join(directory, 'uc'), RUNNER_HOME: join(directory, 'runner') }
function envRoot() { return process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows' }
async function run(program, ...args) {
  return (await execute(program, args, { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout
}
const moved = root + '.independence-check'
await rename(root, moved)
try {
  for (const command of ['uc', 'runner', 'carrier', 'agent', 'agent-manager-mcp', 'mcp-manager', 'prompt-manager',
    'skill-manager', 'conversation-manager', 'orchestration-mcp', 'aixand-connect'])
    assert.ok((await run(command, '--help')).length, command)
  for (const provider of ['codex', 'claude']) await assert.rejects(access(join(prefix, 'bin', provider + '.exe')))
  assert.match(await run('node', '--version'), /v24/)
  assert.match(await run('npm', '--version'), /\d+/)
  assert.match(await run('git', '--version'), /git version/)
  assert.match(await run('UC', '--version'), /uc/)
  const python = join(prefix, 'python/python.exe')
  await run(python, '-B', '-c', 'import agent_manager,carrier,aixand,runner_client,orchestration_mcp,aixand_filesystem,aixand_local_runtime')
  const manifest = JSON.parse(await readFile(join(moved, 'manifest.json')))
  if (manifest.features.voice)
    await run(join(prefix, 'voice/python/python.exe'), '-I', '-B', '-c', 'import aixand_vox.speech,sherpa_onnx')
  await run('uc', 'daemon', 'start')
  await run(python, '-B', '-c', 'import asyncio;from undercurrent import Client\nasync def main():\n async with Client() as client: print(await client.list())\nasyncio.run(main())')
  const defaults = { ...env }
  delete defaults.UNDERCURRENT_HOME
  try {
    await execute('uc', ['daemon', 'start'], { env: defaults, timeout: 60_000 })
    await execute(python, ['-B', '-c', 'import asyncio;from undercurrent import Client\nasync def main():\n async with Client() as client: print(await client.list())\nasyncio.run(main())'], { env: defaults, timeout: 60_000 })
  } finally { await execute('uc', ['daemon', 'stop'], { env: defaults, timeout: 60_000 }).catch(() => {}) }
  const config = join(directory, 'sdk.json')
  await writeFile(config, JSON.stringify({ python_paths: [join(prefix, 'python/Lib/site-packages')],
    python_interpreter: { executable: python, home: join(prefix, 'python') },
    connection: { bridge: join(prefix, 'bin/uc-python-bridge.exe'), state_dir: join(directory, 'sdk'), timeout: 10 } }))
  await run('uc', 'start', 'standalone-runner', '--profile', 'server', '--cwd', directory, '--',
    join(prefix, 'bin/runner.exe'), '--home', env.RUNNER_HOME, 'serve', '--sdk-config', config)
  let healthy = false
  for (let attempt = 0; attempt < 80; attempt++) {
    try { healthy = Boolean(JSON.parse(await run('runner', '--home', env.RUNNER_HOME, 'health'))); break }
    catch { await delay(250) }
  }
  assert.equal(healthy, true, 'Independent Runner did not become ready')
  await run(python, '-B', '-c', 'from runner_client import Client;print(Client().health())')
  const probe = join(directory, 'exit-probe.exe')
  await copyFile(join(prefix, 'bin/aixand-command.exe'), probe)
  for (const code of [37, 300, 0x81000011]) {
    await writeFile(join(directory, 'exit-probe.aixand-command.json'), JSON.stringify({ root: prefix,
      commands: { 'exit-probe': { program: 'node/node.exe', args: ['-e', `process.exit(${code})`] } } }))
    const failure = await execute(probe, [], { env }).then(() => null, error => error)
    assert.equal(failure?.code >>> 0, code, 'Command exit codes must preserve failure status')
  }
  console.log(JSON.stringify({ passed: true, checks: ['ordinary executable commands', 'application payload unavailable',
    'Node/npm', 'provider CLIs excluded', 'core and voice imports', 'default SDK bridge discovery', 'standalone UC',
    'SDK and CLI default home agreement', 'standalone Runner SDK service', 'Python Runner IPC', 'CLI exit codes'] }))
} finally {
  await run('uc', 'stop', 'standalone-runner', '--force').catch(() => {})
  await run('uc', 'daemon', 'stop').catch(() => {})
  await rename(moved, root)
}
