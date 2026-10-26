import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, readdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startupPlan } from './server-startup.mjs'

const execute = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')

test('real console application install, checksum refusal, repair and removal preserve workspace data', { skip: process.platform === 'win32' }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-server-lifecycle-')))
  const root = join(temporary, 'source/runtime'), target = join(temporary, 'installed app 世界'), home = join(temporary, 'home'), workspace = join(home, 'workspace')
  await mkdir(join(root, 'bin'), { recursive: true }); await mkdir(join(root, 'node/bin'), { recursive: true })
  await mkdir(join(root, 'products/consumer'), { recursive: true }); await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'personal-history'), 'must survive')
  const files = ['package-model.mjs', 'platform.mjs', 'runtime.mjs', 'setup.mjs', 'products.mjs', 'uc-connections.mjs', 'cleanup.mjs', 'server-cli.mjs', 'server-installer.mjs', 'server-startup.mjs']
  for (const name of files) await copyFile(new URL(name, import.meta.url), join(root, name))
  await copyFile(process.execPath, join(root, 'node/bin/node')); files.push('node/bin/node')
  const consumer = '# no product operations in this application-payload fixture\n'
  await writeFile(join(root, 'products/consumer/consumer.py'), consumer); files.push('products/consumer/consumer.py')
  const targetName = { linux: 'linux', darwin: 'macos' }[process.platform] + '-' + ({ x64: 'x86_64', arm64: 'arm64' }[process.arch]) + (process.platform === 'linux' ? '-gnu' : '')
  const catalog = JSON.stringify({ schema: 1, target: targetName, consumer: { 'consumer/consumer.py': hash(consumer) }, assemblies:
    ['undercurrent', 'runner', 'carrier', 'manager-suite'].map(id => ({ id, artifact: 'artifacts/' + id, products: { [id]: { version: '0.1.0-beta', release: hash(id), commands: [] } }, licenses: [] })) })
  await writeFile(join(root, 'products/catalog.json'), catalog); files.push('products/catalog.json')
  await writeFile(join(root, 'fixture-data'), 'qualified payload'); files.push('fixture-data')
  let inventory = ''
  for (const name of files.sort()) inventory += hash(await readFile(join(root, name))) + '  ' + name + '\n'
  await writeFile(join(root, 'SHA256SUMS'), inventory)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, features: { voice: false }, build: hash(inventory + 'distributedserver'), installation: { schema: 1, edition: 'distributed', role: 'server', catalogSha256: hash(catalog) } }))
  const helper = join(temporary, 'lifecycle.mjs')
  await writeFile(helper, `import {install,uninstall} from ${JSON.stringify(pathToFileURL(join(root, 'server-installer.mjs')).href)};
import {configuration} from ${JSON.stringify(pathToFileURL(join(root, 'runtime.mjs')).href)};
if(process.argv[2]==='remove') { const current=await import(new URL('./server-installer.mjs','file://'+process.argv[3]+'/')); await current.uninstall({confirmed:true},configuration(process.argv[3],process.env)); }
else await install(process.argv[3],{yes:true,skipSetup:true},process.env);
`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIXAND_LOCAL_HOME: workspace,
    AIXAND_SHARED_PRODUCT_PREFIX: join(home, 'products'), AIXAND_SKIP_PATH_REGISTRATION: '1' }
  try {
    await execute(process.execPath, [helper, 'install', target], { env, timeout: 30_000 })
    assert.equal(await readFile(join(target, 'runtime/fixture-data'), 'utf8'), 'qualified payload')
    assert.equal(existsSync(join(target, 'runtime/web')), false)
    assert.match((await execute(join(target, 'bin/aixand-server'), ['--version'], { env, timeout: 10_000 })).stdout, /0\.1\.0-beta/)
    await execute(join(target, 'bin/aixand-server'), ['configure', '--yes', '--port', '18753', '--carrier-port', '18765'], { env, timeout: 10_000 })
    assert.equal(JSON.parse(await readFile(join(target, 'server-installation.json'), 'utf8')).port, 18753)
    await writeFile(join(target, 'runtime/fixture-data'), 'damaged installed software')
    await execute(process.execPath, [helper, 'repair', target], { env, timeout: 30_000 })
    assert.equal(await readFile(join(target, 'runtime/fixture-data'), 'utf8'), 'qualified payload')
    assert.equal(await readFile(join(workspace, 'personal-history'), 'utf8'), 'must survive')
    await writeFile(join(root, 'fixture-data'), 'damaged installer source')
    await assert.rejects(execute(process.execPath, [helper, 'install', join(temporary, 'refused')], { env, timeout: 30_000 }), /checksum failed/)
    assert.equal(existsSync(join(temporary, 'refused')), false)
    await execute(process.execPath, [helper, 'remove', join(target, 'runtime')], { env, timeout: 30_000 })
    assert.equal(existsSync(target), false)
    assert.equal(await readFile(join(workspace, 'personal-history'), 'utf8'), 'must survive')
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
