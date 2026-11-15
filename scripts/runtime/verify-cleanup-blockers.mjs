// End-to-end checks touch only a generated home and disposable child processes.
// No real provider logout, credentials, software removal, or user process stops.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nodePath, pythonPath } from './platform.mjs'

const root = resolve(process.argv[2]), execute = promisify(execFile)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-blocker-proof-')))
const home = join(temporary, 'home'), base = join(home, 'workspace')
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'),
  APPDATA: join(home, 'AppData/Roaming'), AIXAND_LOCAL_HOME: base,
  AIXAND_SHARED_PRODUCT_PREFIX: join(home, 'products'), AIXAND_SKIP_PATH_REGISTRATION: '1',
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'UNDERCURRENT_HOME', 'UNDERCURRENT_CONFIG', 'UNDERCURRENT_ENDPOINT', 'AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG']) delete env[key]
const children = []
const run = async (...args) => JSON.parse((await execute(nodePath(root), [join(root, 'runtime.mjs'), ...args], {
  env, cwd: temporary, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
})).stdout)
async function put(path, text = 'preserve fixture') { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text) }
async function hold(path) {
  const script = process.platform === 'win32' ? `import ctypes as c,sys,time
k=c.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[c.c_wchar_p,c.c_uint32,c.c_uint32,c.c_void_p,c.c_uint32,c.c_uint32,c.c_void_p]
k.CreateFileW.restype=c.c_void_p
h=k.CreateFileW(sys.argv[1],0x80000000,1,None,3,0,None)
assert h!=c.c_void_p(-1).value,c.get_last_error()
print('ready',flush=True)
time.sleep(180)
` : "import sys,time; f=open(sys.argv[1]); print('ready',flush=True); time.sleep(180)"
  const child = spawn(pythonPath(join(root, 'python')), ['-I', '-B', '-c', script, path], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture file-holder startup timed out.')), 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture file holder exited early.')) })
    child.stdout.once('data', data => { clearTimeout(timer); assert.match(String(data), /ready/); accept() })
  })
  return child
}
const checks = []
try {
  const guard = join(base, 'chats/.codex-provisioning-fixture.guard')
  const accounts = join(base, 'agents/codex/saved-history')
  const password = join(base, 'auth/password-fixture')
  await put(guard); await put(accounts); await put(password)
  const holder = await hold(guard), other = await hold(accounts)
  const plan = await run('cleanup', 'plan')
  const options = { selected: ['workspace'], revision: plan.revision, confirmed: true }
  const report = await run('cleanup', 'apply', JSON.stringify(options))
  assert.equal(report.blocked, true)
  assert.deepEqual(report.completed, [])
  const blocker = report.blockers.find(value => value.pid === holder.pid)
  assert.ok(blocker?.canStop)
  assert.ok(blocker.paths.includes(guard))
  assert.ok(!report.blockers.some(value => value.pid === other.pid))
  assert.equal(await readFile(password, 'utf8'), 'preserve fixture')
  assert.equal(await readFile(accounts, 'utf8'), 'preserve fixture')
  checks.push('guard owner identified before any selected data or password is removed')
  const reviewed = report.blockers.map(({ pid, birth }) => ({ pid, birth }))
  let stopped = await run('cleanup', 'stop-processes', JSON.stringify({ ...options, reviewed }))
  if (stopped.blocked) stopped = await run('cleanup', 'stop-processes', JSON.stringify({ ...options,
    reviewed: stopped.blockers.map(({ pid, birth }) => ({ pid, birth })), force: true, forceConfirmed: true }))
  assert.equal(stopped.blocked, false, JSON.stringify(stopped))
  assert.equal(await readFile(guard, 'utf8'), 'preserve fixture')
  assert.equal(other.exitCode, null)
  assert.equal(other.signalCode, null)
  checks.push('reviewed stop releases the file without deleting history or stopping an unselected holder')
  const removed = await run('cleanup', 'apply', JSON.stringify(options))
  assert.equal(removed.failed, null)
  assert.deepEqual(removed.completed, ['workspace'])
  await assert.rejects(readFile(password), { code: 'ENOENT' })
  assert.equal(await readFile(accounts, 'utf8'), 'preserve fixture')
  checks.push('fresh preflight permits selected workspace removal while keeping provider accounts')
  console.log(JSON.stringify({ passed: true, platform: process.platform, checks, realUserDataModified: false }))
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(accept => child.once('exit', accept))
      child.kill()
      await exited
    }
  }
  await rm(temporary, { recursive: true, force: true })
}
