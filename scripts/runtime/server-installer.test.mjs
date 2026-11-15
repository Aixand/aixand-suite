import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir, realpath, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { recoverDestination, removeApplicationLeftovers, prepareDestination } from './server-installer.mjs'
import { startupPlan } from './server-startup.mjs'

const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')

test('installer can purge tool data when the application has already been removed', { skip: process.platform === 'win32' }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-tools-only-')))
  try {
    const root = join(temporary, 'helper'), home = join(temporary, 'home'), base = join(home, 'workspace'), application = join(home, 'absent-application')
    await mkdir(join(root, 'server'), { recursive: true })
    for (const name of ['activation.mjs', 'component-updates.mjs', 'component-update-worker.mjs', 'component-launcher.mjs', 'updates.mjs', 'runtime.mjs', 'package-model.mjs', 'setup.mjs', 'products.mjs', 'product-selection.mjs', 'product-feed.mjs', 'uc-connections.mjs', 'installation-plan.mjs', 'component-inventory.mjs', 'terminal-ui.mjs', 'cleanup.mjs', 'server-cli.mjs', 'server-installer.mjs', 'server-startup.mjs', 'platform.mjs'])
      await copyFile(new URL(name, import.meta.url), join(root, name))
    const pythonHome = (await execute('python3', ['-I', '-c', 'import sys; print(sys.base_prefix)'])).stdout.trim()
    await symlink(pythonHome, join(root, 'python'), 'dir')
    // The adapter returns no provider installations or process blockers.
    // This test exercises the real installer, runtime and data removal path.
    await writeFile(join(root, 'provider-cleanup.py'), 'import json,sys\njson.load(sys.stdin)\nprint(json.dumps(dict(items=[],revision={},blockers=[],errors=[])))\n')
    const path = join(home, '.aixand/carrier/carrier.db')
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'data')
    // An allowlist prevents cleanup from inheriting any host store or account path.
    const env = { HOME: home, USERPROFILE: home, PATH: '', SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
      TEMP: temporary, TMP: temporary, AIXAND_LOCAL_HOME: base, AIXAND_SHARED_PRODUCT_PREFIX: join(home, 'products') }
    const result = await execute(process.execPath, [join(root, 'server-installer.mjs'), 'uninstall', '--directory', application, '--remove-target', 'tools', '--purge', '--yes', '--json'], { env, timeout: 30000 })
    assert.deepEqual(JSON.parse(result.stdout).completed, ['tool-data:carrier_home'])
    assert.match(result.stderr, /Removed: tool-data:carrier_home/)
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(application), false)
    await mkdir(application); await writeFile(join(application, 'old-backup.json'), 'leftover')
    await mkdir(join(base, 'chats'), { recursive: true }); await writeFile(join(base, 'chats/history'), 'history')
    await mkdir(join(base, 'projects'), { recursive: true }); await writeFile(join(base, 'projects/keep'), 'project')
    const native = join(home, 'native-login.json')
    await writeFile(native, 'keep native login')
    const nativePlan = { items: [{ id: 'native:codex', label: 'Native Codex account', shared: true, available: true, paths: [native] }], revision: {}, blockers: [], errors: [] }
    await writeFile(join(root, 'provider-cleanup.py'), 'import json,sys\njson.load(sys.stdin)\nprint(' + JSON.stringify(JSON.stringify(nativePlan)) + ')\n')
    const everything = await execute(process.execPath, [join(root, 'server-installer.mjs'), 'uninstall', '--directory', application, '--remove-target', 'everything', '--existing-files', 'remove', '--yes', '--json'], { env, timeout: 30000 })
    assert.equal(JSON.parse(everything.stdout).leftoversRemoved, true)
    assert.equal(await readFile(native, 'utf8'), 'keep native login')
    assert.equal(existsSync(application), false)
    assert.equal(existsSync(join(base, 'chats')), false)
    assert.equal(await readFile(join(base, 'projects/keep'), 'utf8'), 'project')
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('real console application install, checksum refusal, repair and removal preserve workspace data', { skip: process.platform === 'win32' }, async () => {
  const version = '7.6.5-alpha.4'
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-server-lifecycle-')))
  const root = join(temporary, 'source/runtime'), target = join(temporary, 'installed app 世界'), home = join(temporary, 'home'), workspace = join(home, 'workspace')
  await mkdir(join(root, 'bin'), { recursive: true }); await mkdir(join(root, 'node/bin'), { recursive: true })
  await mkdir(join(root, 'products/consumer'), { recursive: true }); await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'personal-history'), 'must survive')
  const files = ['activation.mjs', 'package-model.mjs', 'platform.mjs', 'component-updates.mjs', 'component-update-worker.mjs', 'component-launcher.mjs', 'updates.mjs', 'runtime.mjs', 'setup.mjs', 'products.mjs', 'product-selection.mjs', 'product-feed.mjs', 'uc-connections.mjs', 'installation-plan.mjs', 'component-inventory.mjs', 'terminal-ui.mjs', 'cleanup.mjs', 'server-cli.mjs', 'server-installer.mjs', 'server-startup.mjs']
  for (const name of files) await copyFile(new URL(name, import.meta.url), join(root, name))
  await copyFile(process.execPath, join(root, 'node/bin/node')); files.push('node/bin/node')
  const consumer = '# no product operations in this application-payload fixture\n'
  await writeFile(join(root, 'products/consumer/consumer.py'), consumer); files.push('products/consumer/consumer.py')
  const targetName = { linux: 'linux', darwin: 'macos' }[process.platform] + '-' + ({ x64: 'x86_64', arm64: 'arm64' }[process.arch]) + (process.platform === 'linux' ? '-gnu' : '')
  const catalog = JSON.stringify({ schema: 1, target: targetName, consumer: { 'consumer/consumer.py': hash(consumer) }, assemblies:
    ['undercurrent', 'runner', 'carrier', 'agent-manager', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager', 'orchestration-mcp'].map(id => ({ id, artifact: 'artifacts/' + id, products: { [id]: { version: '0.1.0-beta', release: hash(id), commands: [] } }, licenses: [] })) })
  await writeFile(join(root, 'products/catalog.json'), catalog); files.push('products/catalog.json')
  await writeFile(join(root, 'fixture-data'), 'qualified payload'); files.push('fixture-data')
  let inventory = ''
  for (const name of files.sort()) inventory += hash(await readFile(join(root, name))) + '  ' + name + '\n'
  await writeFile(join(root, 'SHA256SUMS'), inventory)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, version, features: { voice: false }, build: hash(inventory + 'distributedserver'), installation: { schema: 1, edition: 'distributed', role: 'server', catalogSha256: hash(catalog) } }))
  const helper = join(temporary, 'lifecycle.mjs')
  await writeFile(helper, `import {install,uninstall,prepareDestination} from ${JSON.stringify(pathToFileURL(join(root, 'server-installer.mjs')).href)};
import {configuration} from ${JSON.stringify(pathToFileURL(join(root, 'runtime.mjs')).href)};
if(process.argv[2]==='remove') { const current=await import(new URL('./server-installer.mjs','file://'+process.argv[3]+'/')); await current.uninstall({confirmed:true,leftoverEntries:process.argv[4]==='all'?['leftover.json']:[]},configuration(process.argv[3],process.env)); }
else { const options={yes:true,skipSetup:true,...(process.argv[2].startsWith('fresh-')?{existingFiles:process.argv[2].slice(6)}:{})}; if(options.existingFiles) await prepareDestination(process.argv[3],options,process.env); await install(process.argv[3],options,process.env); }
`)
  const env = { HOME: home, USERPROFILE: home, PATH: '', SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'), TEMP: temporary, TMP: temporary, AIXAND_LOCAL_HOME: workspace,
    AIXAND_SHARED_PRODUCT_PREFIX: join(home, 'products'), AIXAND_SKIP_PATH_REGISTRATION: '1' }
  try {
    await mkdir(target); await writeFile(join(target, 'old-backup.json'), 'preserve old backup')
    await execute(process.execPath, [helper, 'fresh-backup', target], { env, timeout: 30_000 })
    const backup = (await readdir(temporary)).find(name => name.startsWith('installed app 世界.backup-'))
    assert.equal(await readFile(join(temporary, backup, 'old-backup.json'), 'utf8'), 'preserve old backup')
    assert.equal(await readFile(join(target, 'runtime/fixture-data'), 'utf8'), 'qualified payload')
    assert.equal(existsSync(join(target, 'runtime/web')), false)
    assert.equal((await execute(join(target, 'bin/aixand-server'), ['--version'], { env, timeout: 10_000 })).stdout.trim(), version)
    await execute(join(target, 'bin/aixand-server'), ['configure', '--yes', '--port', '18753', '--carrier-port', '18765'], { env, timeout: 10_000 })
    assert.equal(JSON.parse(await readFile(join(target, 'server-installation.json'), 'utf8')).port, 18753)
    await writeFile(join(target, 'runtime/fixture-data'), 'damaged installed software')
    await execute(process.execPath, [helper, 'repair', target], { env, timeout: 30_000 })
    assert.equal(await readFile(join(target, 'runtime/fixture-data'), 'utf8'), 'qualified payload')
    assert.equal(await readFile(join(workspace, 'personal-history'), 'utf8'), 'must survive')
    await writeFile(join(root, 'fixture-data'), 'damaged installer source')
    await assert.rejects(execute(process.execPath, [helper, 'install', join(temporary, 'refused')], { env, timeout: 30_000 }), /checksum failed/)
    assert.equal(existsSync(join(temporary, 'refused')), false)
    await writeFile(join(target, 'leftover.json'), 'keep by default')
    await execute(process.execPath, [helper, 'remove', join(target, 'runtime')], { env, timeout: 30_000 })
    assert.equal(await readFile(join(target, 'leftover.json'), 'utf8'), 'keep by default')
    assert.equal(existsSync(join(target, 'server-installation.json')), false)
    await removeApplicationLeftovers(target, ['leftover.json'], env)
    assert.equal(existsSync(target), false)
    assert.equal(await readFile(join(workspace, 'personal-history'), 'utf8'), 'must survive')
    await mkdir(target); await writeFile(join(target, 'old-backup.json'), 'delete this backup')
    // An invalid payload must not delete existing files.
    await assert.rejects(execute(process.execPath, [helper, 'fresh-remove', target], { env, timeout: 30_000 }), /checksum failed/)
    assert.equal(await readFile(join(target, 'old-backup.json'), 'utf8'), 'delete this backup')
    await writeFile(join(root, 'fixture-data'), 'qualified payload')
    await execute(process.execPath, [helper, 'fresh-remove', target], { env, timeout: 30_000 })
    assert.equal(existsSync(join(target, 'old-backup.json')), false)
    assert.equal(await readFile(join(target, 'runtime/fixture-data'), 'utf8'), 'qualified payload')
    await writeFile(join(target, 'leftover.json'), 'explicitly delete')
    await execute(process.execPath, [helper, 'remove', join(target, 'runtime'), 'all'], { env, timeout: 30_000 })
    assert.equal(existsSync(target), false)
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5 }) }
})

test('startup registrations are instance-specific, quote paths, and never request system ownership', () => {
  const config = { root: '/applications/server space/%literal', base: '/home/example/workspace', env: { HOME: '/home/example' }, input: {} }
  const linux = startupPlan(config, 'linux'), mac = startupPlan(config, 'darwin'), windows = startupPlan(config, 'win32')
  assert.match(linux.content, /ExecStart=".*server space\/%%literal/)
  assert.doesNotMatch(linux.content, /User=root|After=default.target/)
  assert.match(mac.content, /Launch|ProgramArguments/)
  assert.match(windows.taskArguments, /-WindowStyle Hidden -EncodedCommand /)
  assert.notEqual(startupPlan({ ...config, base: '/another/workspace' }, 'linux').name, linux.name)
  assert.throws(() => startupPlan({ ...config, base: '/invalid\nworkspace' }), /control characters/)
})


test('existing-file recovery preserves backups, requires explicit removal, and rejects redirected paths', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-recovery-')))
  const target = join(temporary, 'application'), home = join(temporary, 'home'), env = { HOME: home }
  try {
    await mkdir(target); await mkdir(home)
    await writeFile(join(target, 'backup.json'), 'keep me')
    await assert.rejects(prepareDestination(target, { yes: true }, env, { log() {} }), /--yes alone never removes/)
    assert.equal(await readFile(join(target, 'backup.json'), 'utf8'), 'keep me')
    await assert.rejects(prepareDestination(target, {}, env, { log() {}, choose: async () => 'cancel' }), /cancelled/)
    await assert.rejects(prepareDestination(target, {}, env, { log() {}, choose: async () => 'remove', confirm: async () => false }), /cancelled/)
    const other = join(temporary, 'other')
    assert.equal(await prepareDestination(target, {}, env, { log() {}, choose: async () => 'directory', question: async () => other }), other)
    const result = await recoverDestination(target, 'backup', env)
    assert.equal(await readFile(join(result.backup, 'backup.json'), 'utf8'), 'keep me')
    assert.equal(existsSync(target), false)
    await mkdir(target); await writeFile(join(target, 'old'), 'remove me')
    await symlink(result.backup, join(target, 'outside'), 'dir')
    await recoverDestination(target, 'remove', env)
    assert.equal(existsSync(target), false)
    assert.equal(await readFile(join(result.backup, 'backup.json'), 'utf8'), 'keep me')
    await assert.rejects(recoverDestination(home, 'remove', env), /dedicated absolute/)
    await symlink(result.backup, target, 'dir')
    await assert.rejects(recoverDestination(target, 'remove', env), /symbolic links/)
    await rm(target)
    await mkdir(target); await writeFile(join(target, 'old'), 'remove me')
    await assert.rejects(removeApplicationLeftovers(target, ['../home'], env), /Invalid application leftover/)
    await removeApplicationLeftovers(target, ['old'], env)
    assert.equal(existsSync(target), false)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
