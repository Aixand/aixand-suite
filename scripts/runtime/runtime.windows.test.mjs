import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, delimiter } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { configuration } from './runtime.mjs'
import { execFileSync } from 'node:child_process'

test('Windows configuration respects case-insensitive overrides and isolates private state', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand-windows-config-'))
  try {
    const root = join(temporary, 'program files', 'runtime')
    const home = join(temporary, 'user')
    const local = join(home, 'AppData', 'Local')
    const config = configuration(root, { userprofile: home, localappdata: local,
      Path: 'C:\\developer\\bin', SystemRoot: 'C:\\Windows', aixand_local_port: '18753',
      AGENTS_PYTHON: 'C:\\developer\\python.exe', PYTHONPATH: 'C:\\developer\\packages', API_KEY: 'private' })
    assert.equal(config.address, 'http://127.0.0.1:18753/')
    assert.equal(config.base, join(local, 'Aixand', 'local'))
    assert.equal(config.tools.python, join(root, 'python', 'python.exe'))
    assert.equal(config.env.AGENTS_PYTHON, config.tools.python)
    assert.equal(config.env.UNDERCURRENT_HOME, join(config.base, 'uc'))
    assert.equal(config.env.SystemRoot, 'C:\\Windows')
    assert.equal(config.env.PYTHONUTF8, '1')
    assert.equal(config.env.PYTHONIOENCODING, 'utf-8')
    const powershell = join(config.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    // This is the actual platform guard in Codex's official install.ps1.
    const { platformEnvironment } = await import('../../apps/server/src/platform-environment.ts')
    for (const env of [config.env, platformEnvironment()])
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        'if ($env:OS -ne "Windows_NT") { exit 1 }'], { env, windowsHide: true })
    assert.equal(config.env.TEMP, join(config.base, 'cache/tmp'))
    assert.equal(config.env.TMP, config.env.TEMP)
    assert.equal(config.env.PYTHONPATH, undefined)
    assert.equal(config.env.API_KEY, undefined)
    assert.ok(config.env.PATH.split(delimiter).includes(join(root, 'bin')))
    assert.ok(!config.env.PATH.includes('developer'))
    assert.ok(config.env.TERMINAL_SHELL.toLowerCase().endsWith('powershell.exe'))
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
