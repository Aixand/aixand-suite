// Run as root only inside the disposable installed-package test container.
// Install as an ordinary user, remove the desktop package, then run its tools.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
assert.equal(process.getuid(), 0)
const home = '/home/aixand-test'
const environment = ['HOME=' + home, 'PATH=' + home + '/.local/bin:/usr/bin:/bin']
async function user(program, args, timeout = 300_000) {
  return (await execute('/usr/sbin/runuser', ['-u', 'aixand-test', '--', '/usr/bin/env', ...environment, program, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout
}
const installed = JSON.parse(await user('/usr/bin/aixand-runtime', ['setup', 'install', '{"mode":"system"}']))
assert.equal(installed.ready, true, JSON.stringify(installed.checks))
await execute('/usr/bin/dpkg', ['--remove', 'aixand'], { timeout: 120_000 })
await assert.rejects(access('/usr/bin/aixand-desktop'))
await assert.rejects(access('/usr/lib/Aixand/runtime/node/bin/node'))
for (const name of ['uc', 'runner', 'carrier', 'agent', 'mcp-manager', 'prompt-manager', 'skill-manager', 'server-manager', 'orchestration-mcp', 'aixand-mcp', 'aixand-connect'])
  assert.ok((await user(name, ['--help'])).length)
for (const provider of ['codex', 'claude']) await assert.rejects(access(home + '/.local/bin/' + provider))
assert.match(await user('node', ['--version']), /^v24\./)
assert.match(await user('npm', ['--version']), /^\d+\./)
await user(installed.tools.python, ['-I', '-B', '-c', 'import agent_manager,carrier,aixand,runner_client,orchestration_mcp'])
if (installed.tools.voicePython) await user(installed.tools.voicePython, ['-I', '-B', '-c', 'import aixand_vox.speech,sherpa_onnx'])
let runner
try {
  await user('uc', ['daemon', 'start'])
  assert.equal(JSON.parse(await user('uc', ['--json', 'daemon', 'status'])).accepting_connections, true)
  await user(installed.tools.python, ['-I', '-B', '-c', 'import asyncio\nfrom undercurrent import Client\nasync def check():\n    async with Client() as client:\n        assert isinstance(await client.list(), list)\nasyncio.run(check())'])
  const config = home + '/standalone-sdk.json'
  await writeFile(config, JSON.stringify({ python_paths: installed.tools.pythonPaths,
    connection: { bridge: installed.tools.bridge, state_dir: home + '/standalone-effects', stable_for: 2, timeout: 300 } }), { mode: 0o644 })
  const args = ['--home', home + '/standalone-runner', 'serve', '--sdk-config', config, '--suite-socket', home + '/standalone-host.sock']
  runner = spawn('/usr/sbin/runuser', ['-u', 'aixand-test', '--', '/usr/bin/env', ...environment, 'runner', ...args], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await user('runner', ['--home', home + '/standalone-runner', 'health'], 5000); ready = true; break }
    catch { await delay(100) }
  }
  assert.ok(ready, 'Standalone Runner must load its SDK and start after app removal')
  console.log(JSON.stringify({ passed: true, checks: ['ordinary user installation', 'desktop package removed', 'normal CLI commands without aliases', 'independent Node and npm', 'independent Python and voice dependencies', 'standalone Undercurrent daemon', 'default Python SDK bridge discovery', 'standalone Runner with SDK support'] }))
} finally {
  if (runner?.pid) { try { process.kill(-runner.pid, 'SIGTERM') } catch {} }
  await user('uc', ['daemon', 'stop']).catch(() => {})
}
