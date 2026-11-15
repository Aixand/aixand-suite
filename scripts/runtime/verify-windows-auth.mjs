import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

assert.equal(process.platform, 'win32')
const root = resolve(process.argv[2])
process.env.AGENTS_PYTHON = join(root, 'python/python.exe')
process.env.AIXAND_PACKAGED_RUNTIME = '1'
const { AuthStore, authInitializationMarker } = await import(pathToFileURL(join(root, 'server/dist/auth/store.js')).href)
const native = createRequire(import.meta.url)(join(root, 'server/dist/auth/auth_directory.node'))
assert.equal(typeof native.check, 'function')
const directory = mkdtempSync(join(tmpdir(), 'aixand-windows-auth-'))
const privateDirectory = join(directory, 'private')
const file = join(privateDirectory, 'auth.db')
let store
try {
  store = new AuthStore(file, { initialize: true })
  assert.equal(store.credential().state, 'setup_pending')
  const started = performance.now()
  for (let index = 0; index < 100; index++) assert.equal(store.credential().state, 'setup_pending')
  const checksMs = performance.now() - started
  assert.ok(checksMs < 3000, `100 live authentication checks took ${Math.round(checksMs)} ms`)
  for (const value of [undefined, null, 42, '', 'relative', privateDirectory + '\u0000suffix', privateDirectory + '.'])
    assert.throws(() => native.check(value))
  store.close()
  store = new AuthStore(file)
  const icacls = join(process.env.SystemRoot, 'System32/icacls.exe')
  execFileSync(icacls, [privateDirectory, '/grant', '*S-1-1-0:(RX)'])
  assert.throws(() => store.credential(), /private authentication directory/)
  execFileSync(icacls, [privateDirectory, '/remove:g', '*S-1-1-0'])
  assert.equal(store.credential().state, 'setup_pending')
  store.close(); store = undefined

  const shared = join(directory, 'shared')
  mkdirSync(shared)
  assert.throws(() => new AuthStore(join(shared, 'auth.db'), { initialize: true }), /private authentication directory/)
  assert.equal(existsSync(join(shared, 'auth.db')), false)
  assert.equal(existsSync(authInitializationMarker(join(shared, 'auth.db'))), false)

  rmSync(file)
  assert.throws(() => new AuthStore(file, { initialize: true }), /cannot be reopened/)
  assert.equal(existsSync(file), false)
  const alias = join(directory, 'junction')
  symlinkSync(privateDirectory, alias, 'junction')
  assert.throws(() => native.check(alias))
  assert.throws(() => new AuthStore(join(alias, 'auth.db'), { initialize: true }), /private authentication directory/)
  console.log(`Windows authentication ACLs, live permission changes, shared-directory refusal, junction refusal, deletion lockout, and 100 native checks (${Math.round(checksMs)} ms) passed`)
} finally {
  store?.close()
  rmSync(directory, { recursive: true, force: true })
}
