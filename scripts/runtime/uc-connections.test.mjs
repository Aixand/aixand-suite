import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerUcConnection, removeUcConnection, ucConnectionStatus } from './uc-connections.mjs'

const execute = promisify(execFile)
const uc = process.env.AIXAND_UC_TEST_BIN || resolve(dirname(fileURLToPath(import.meta.url)),
  '../../../undercurrent/target/debug', process.platform === 'win32' ? 'uc.exe' : 'uc')
const native = { skip: !existsSync(uc) && 'Build UC or set AIXAND_UC_TEST_BIN for native connection tests' }

async function fixture() {
  const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'uc-link-')))
  const home = join(directory, 'home'), base = join(directory, 'suite')
  await mkdir(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  for (const key of ['UNDERCURRENT_HOME', 'UNDERCURRENT_CONFIG', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) delete env[key]
  const run = async (args, runtime = false) => JSON.parse((await execute(uc, ['--json', ...args], {
    env: { ...env, ...(runtime ? { UNDERCURRENT_HOME: join(base, 'uc') } : {}) },
    windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  })).stdout)
  return { directory, home, base, env, run, async cleanup() {
    await run(['daemon', 'stop'], true).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  } }
}

test('Suite registers the real UC connection and later setup preserves manual choices', native, async () => {
  const f = await fixture()
  try {
    await f.run(['daemon', 'start'], true)
    const first = await registerUcConnection(uc, { ...f.env, UNDERCURRENT_HOME: join(f.base, 'uc') }, f.base)
    assert.equal(first.verified, true)
    assert.equal(first.activeProfile, 'aixand-suite')
    const shown = await f.run(['settings', 'show'])
    assert.equal(shown.effective.source, 'saved_profile')
    assert.equal(shown.effective.home, join(f.base, 'uc'))
    assert.equal(shown.effective.auto_start, 'never')
    assert.equal((await f.run(['ls'])).items.length, 0)
    await f.run(['settings', 'set', 'profile', 'default'])
    assert.equal((await registerUcConnection(uc, f.env, f.base)).activeProfile, 'default')
    // A user can forget the connection; an upgrade may register it again but
    // must not reclaim the saved default after initial setup was recorded.
    await f.run(['settings', 'profiles', 'remove', 'aixand-suite'])
    assert.equal((await registerUcConnection(uc, f.env, f.base)).activeProfile, 'default')
    assert.equal(ucConnectionStatus(f.base).profile, 'aixand-suite')
  } finally { await f.cleanup() }
})

test('a failed connection never reports successful setup and retry preserves user selection', native, async () => {
  const f = await fixture()
  try {
    await assert.rejects(registerUcConnection(uc, f.env, f.base), /Could not configure/)
    assert.equal(ucConnectionStatus(f.base), null)
    assert.equal(existsSync(join(f.base, 'uc/state')), false)
    await f.run(['settings', 'set', 'profile', 'default'])
    await f.run(['daemon', 'start'], true)
    const retry = await registerUcConnection(uc, f.env, f.base)
    assert.equal(retry.activeProfile, 'default')
    assert.equal(retry.verified, true)
  } finally { await f.cleanup() }
})

test('Suite does not overwrite another connection owner', native, async () => {
  const f = await fixture()
  try {
    await f.run(['settings', 'profiles', 'add', 'aixand-suite', '--home', join(f.directory, 'independent')])
    await assert.rejects(registerUcConnection(uc, f.env, f.base), /another owner/)
    assert.equal((await f.run(['settings', 'show'])).active_profile, 'default')
    assert.equal(ucConnectionStatus(f.base), null)
  } finally { await f.cleanup() }
})

test('invalid setup records remain visible and are not silently overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uc-record-'))
  try {
    await mkdir(join(directory, 'config'))
    await writeFile(join(directory, 'config/uc-cli-connection.json'), JSON.stringify({ schema: 1, profile: 'another' }))
    assert.throws(() => ucConnectionStatus(directory), /Invalid saved/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('server profiles preserve terminal defaults and are retained when Desktop reuses the workspace', native, async () => {
  const f = await fixture()
  const other = join(f.directory, 'other-server')
  try {
    await f.run(['daemon', 'start'], true)
    const server = await registerUcConnection(uc, f.env, f.base, 'server')
    assert.match(server.profile, /^aixand-server-[a-f0-9]{12}$/)
    assert.equal(server.owner, 'aixand-server')
    await f.run(['settings', 'set', 'profile', 'default'])
    const different = await registerUcConnection(uc, { ...f.env, UNDERCURRENT_HOME: join(f.base, 'uc') }, other, 'server')
    assert.notEqual(different.profile, server.profile)
    assert.equal(different.verification, 'configuration')
    assert.equal(different.home, join(other, 'uc'))
    assert.equal((await f.run(['settings', 'show'])).active_profile, 'default')
    assert.equal((await registerUcConnection(uc, f.env, f.base, 'desktop')).profile, server.profile)
    await removeUcConnection(uc, f.env, f.base)
    assert.equal((await f.run(['settings', 'show'])).active_profile, 'default')
  } finally { await f.cleanup() }
})

test('reset forgets only its owned Suite profile and returns selection to permanent default', native, async () => {
  const f = await fixture()
  try {
    await f.run(['daemon', 'start'], true)
    await registerUcConnection(uc, f.env, f.base)
    await f.run(['settings', 'profiles', 'add', 'work', '--home', join(f.directory, 'work')])
    await f.run(['daemon', 'stop'], true)
    assert.equal((await removeUcConnection(uc, f.env, f.base)).removed, true)
    const listing = await f.run(['settings', 'profiles', 'list'])
    assert.equal(listing.active_profile, 'default')
    assert.ok(listing.profiles.default)
    assert.ok(listing.profiles.work)
    assert.equal(listing.profiles['aixand-suite'], undefined)
  } finally { await f.cleanup() }
})

test('reset preserves a Suite-named profile that was reassigned to a different home', native, async () => {
  const f = await fixture()
  try {
    await f.run(['daemon', 'start'], true)
    await registerUcConnection(uc, f.env, f.base)
    await f.run(['settings', 'profiles', 'remove', 'aixand-suite'])
    await f.run(['settings', 'profiles', 'add', 'aixand-suite', '--home', join(f.directory, 'other-owner')])
    await assert.rejects(removeUcConnection(uc, f.env, f.base), /another workspace/)
    assert.equal((await f.run(['settings', 'profiles', 'list'])).profiles['aixand-suite'].home, join(f.directory, 'other-owner'))
  } finally { await f.cleanup() }
})
