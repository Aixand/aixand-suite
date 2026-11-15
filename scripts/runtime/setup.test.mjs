import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSystem } from './setup.mjs'
import { binary, pythonPath } from './platform.mjs'

const execute = promisify(execFile)
const runtime = process.env.AIXAND_TEST_SYSTEM_RUNTIME

test('system discovery preserves selected venv and base interpreter identities', { skip: !runtime }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-system-venv-'))
  try {
    const root = join(directory, 'package'), venv = join(directory, 'environment'), home = join(directory, 'home')
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(home)
    await copyFile(join(runtime, 'manifest.json'), join(root, 'manifest.json'))
    for (const name of ['uc', 'runner'])
      await symlink(join(runtime, 'bin', binary(name)), join(root, 'bin', binary(name)))
    const env = { ...process.env, HOME: home, USERPROFILE: home, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
    delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
    await execute(pythonPath(join(runtime, 'python')), ['-I', '-B', '-m', 'venv', '--without-pip', '--system-site-packages', venv], { env })
    const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
    const { stdout } = await execute(python, ['-I', '-B', '-c',
      'import json,sys;print(json.dumps(dict(executable=sys.executable,prefix=sys.prefix,home=sys.base_prefix,base_executable=sys._base_executable)))'], { env })
    const expected = JSON.parse(stdout)
    const result = await inspectSystem(root, env, { python, binDirectory: join(runtime, 'bin') })
    assert.equal(result.ready, true, JSON.stringify(result.checks))
    assert.equal(result.tools.python, python)
    assert.equal(result.tools.pythonExecutable, expected.executable)
    assert.equal(result.tools.pythonPrefix, expected.prefix)
    assert.equal(result.tools.pythonHome, expected.home)
    assert.equal(result.tools.pythonBaseExecutable, expected.base_executable)
    assert.notEqual(result.tools.pythonPrefix, result.tools.pythonHome)
    if (process.platform !== 'win32') {
      const wrapper = join(directory, 'python-wrapper')
      await writeFile(wrapper, '#!/bin/sh\nexec ' + JSON.stringify(python) + ' "$@"\n', { mode: 0o700 })
      const wrapped = await inspectSystem(root, env, { python: wrapper, binDirectory: join(runtime, 'bin') })
      assert.equal(wrapped.ready, true, JSON.stringify(wrapped.checks))
      assert.equal(wrapped.tools.python, wrapper)
      assert.equal(wrapped.tools.pythonExecutable, expected.executable)
      assert.equal(wrapped.tools.pythonPrefix, expected.prefix)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
