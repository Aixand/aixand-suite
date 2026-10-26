import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execute = promisify(execFile)

test('runtime entry point returns JSON from desktop launch paths and stays idle when imported', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand entry π '))
  try {
    const root = join(temporary, 'runtime')
    await mkdir(root)
    for (const name of ['runtime.mjs', 'package-model.mjs', 'setup.mjs', 'platform.mjs', 'products.mjs', 'uc-connections.mjs', 'cleanup.mjs'])
      await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(root, name))
    const env = { ...process.env, AIXAND_LOCAL_HOME: join(temporary, 'state'),
      AIXAND_LOCAL_PORT: '18753', AIXAND_LOCAL_CARRIER_PORT: '18765' }
    const paths = process.platform === 'win32' ? [root, toNamespacedPath(root)] : [root]
    for (const path of paths) {
      const { stdout, stderr } = await execute(process.execPath,
        [join(path, 'runtime.mjs'), 'setup', 'info', '{}'],
        { cwd: path, env, windowsHide: true, timeout: 20_000 })
      const result = JSON.parse(stdout)
      assert.equal(result.configured, false)
      assert.equal(result.mode, 'bundled')
      assert.equal(result.dataDirectory, env.AIXAND_LOCAL_HOME)
      assert.equal(stderr, '')
    }
    const imported = await execute(process.execPath,
      ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(join(root, 'runtime.mjs')).href],
      { env, windowsHide: true, timeout: 20_000 })
    assert.equal(imported.stdout, '')
    assert.equal(imported.stderr, '')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
