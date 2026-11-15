// Console installation/maintenance front end. Product operations remain in the
// shared runtime; this module owns only the Server application payload.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { cp, readFile, writeFile, mkdir, rename, rm, lstat, realpath, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve, parse, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { configuration, stop, status } from './runtime.mjs'
import { binary, nodePath, inside, addUserPath, removeUserPath } from './platform.mjs'
import { question, parseOptions, instanceEnvironment, cleanup } from './server-cli.mjs'
import { startup } from './server-startup.mjs'
import { choose, confirm, color } from './terminal-ui.mjs'
import { componentInventory, applicationAt } from './component-inventory.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const marker = 'server-installation.json'
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"

export function defaultDestination(input = process.env) {
  const home = input.HOME || input.USERPROFILE || homedir()
  return process.platform === 'win32' ? join(input.LOCALAPPDATA || join(home, 'AppData/Local'), 'AixandServer')
    : join(input.XDG_DATA_HOME || join(home, '.local/share'), 'aixand-server/application')
}

export async function safeDestination(path, input = process.env, { installedSelf = false, allowUnrecognized = false } = {}) {
  const home = resolve(input.HOME || input.USERPROFILE || homedir()), target = resolve(path)
  const self = installedSelf && resolve(source) === join(target, 'runtime') && existsSync(join(target, marker))
  if (!isAbsolute(path) || [home, parse(target).root].includes(target) || !self && (inside(source, target) || inside(target, source)))
    throw new Error('Choose a dedicated absolute Server application directory.')
  for (let current = target; ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Application paths cannot traverse symbolic links or junctions.') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current === parse(current).root) break
  }
  if (existsSync(target)) {
    const entries = await readdir(target)
    if (entries.length && !existsSync(join(target, marker)) && !allowUnrecognized) throw new Error('This directory is not a recognized Aixand Server installation. It contains files but has no server-installation.json: ' + target + '. Choose another directory or explicitly back up/remove existing files.')
    if (entries.length && existsSync(join(target, marker))) {
      const saved = JSON.parse(await readFile(join(target, marker), 'utf8'))
      if (saved.schema !== 1 || saved.application !== 'org.aixand.server' || resolve(saved.directory) !== target)
        throw new Error('The existing Server installation owner could not be verified.')
    }
  }
  return target
}

// Explicit recovery applies only to an unrecognized directory. The path guards
// still apply, including when automation requests permanent removal.
export async function recoverDestination(destination, action, input = process.env) {
  if (!['backup', 'remove'].includes(action)) throw new Error('Choose backup or remove for existing files.')
  const target = await safeDestination(destination, input, { allowUnrecognized: true })
  if (existsSync(join(target, marker))) throw new Error('Use Uninstall for a recognized installation before a fresh install.')
  if (!existsSync(target) || !(await readdir(target)).length) return { directory: target }
  const backup = target + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID()
  await rename(target, backup)
  if (action === 'remove') {
    try { await rm(backup, { recursive: true, force: true, maxRetries: 5 }) }
    catch (error) { throw new Error('Removal is incomplete. Remaining files: ' + backup, { cause: error }) }
  }
  return { directory: target, ...(action === 'backup' ? { backup } : {}) }
}

function validateLeftoverEntries(entries) {
  if (!Array.isArray(entries) || entries.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)))
    throw new Error('Invalid application leftover entry.')
}

export async function removeApplicationLeftovers(destination, entries, input = process.env) {
  validateLeftoverEntries(entries)
  const target = await safeDestination(destination, input, { allowUnrecognized: true })
  if (existsSync(join(target, marker))) throw new Error('Remove the recognized application before removing leftovers.')
  for (const name of entries) await rm(join(target, name), { recursive: true, force: true, maxRetries: 5 })
  if (existsSync(target) && !(await readdir(target)).length) await rm(target, { recursive: true })
}

export async function prepareDestination(destination, options, input = process.env, ui = { choose, confirm, question, log: console.log }) {
  for (;;) {
    const target = await safeDestination(destination, input, { allowUnrecognized: true })
    if (!existsSync(target) || existsSync(join(target, marker)) || !(await readdir(target)).length) return target
    ui.log('This directory contains files but has no server-installation.json: ' + target)
    for (const name of await readdir(target)) ui.log('  ' + name)
    let action = options.existingFiles
    if (!action && !options.yes) action = await ui.choose('How should these existing files be handled?', [
      { value: 'backup', label: 'Back up these files and install' },
      { value: 'remove', label: 'Remove everything in this application directory and install', detail: 'Permanent removal' },
      { value: 'directory', label: 'Choose another directory' },
      { value: 'cancel', label: 'Cancel' },
    ])
    if (action === 'directory') { destination = await ui.question('Application directory: '); continue }
    if (action === 'cancel') throw new Error('Installation cancelled.')
    if (!action) throw new Error('Choose another directory or use --existing-files backup|remove explicitly. --yes alone never removes existing files.')
    if (action === 'remove' && !options.yes && !await ui.confirm('Permanently delete ALL contents of ' + target + '?')) throw new Error('Installation cancelled.')
    // Verify the payload before moving or deleting existing files.
    await verifyRuntime(source)
    const result = await recoverDestination(target, action, input)
    if (result.backup) ui.log('Existing files backed up to: ' + result.backup)
    return target
  }
}

async function verifyWorkspace(path, application) {
  if (!isAbsolute(path) || /[\r\n\0]/.test(path) || inside(path, application) || inside(application, path))
    throw new Error('Choose a dedicated absolute workspace outside the application directory.')
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (info?.isSymbolicLink()) throw new Error('Use the real workspace directory rather than a symbolic link or junction.')
    if (current === parse(current).root) break
  }
}

export async function verifyRuntime(root) {
  const canonical = await realpath(root)
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (manifest.installation?.role !== 'server' || manifest.installation.edition !== 'distributed' || existsSync(join(root, 'web')))
    throw new Error('Expected a frontend-free distributed Server runtime.')
  const inventory = await readFile(join(root, 'SHA256SUMS'), 'utf8')
  const build = createHash('sha256').update(inventory + 'distributedserver').digest('hex')
  if (build !== manifest.build) throw new Error('Server runtime identity failed verification.')
  const paths = new Set(), entries = inventory.trimEnd().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/)
    if (!match || !inside(resolve(root, match[2]), root) || match[2].split(/[\\/]/).some(part => part === '..') || paths.has(match[2]))
      throw new Error('Invalid or duplicate Server runtime inventory entry.')
    paths.add(match[2]); return { hash: match[1], name: match[2] }
  })
  let index = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (index < entries.length) {
      const entry = entries[index++], file = join(root, entry.name)
      if (!inside(await realpath(file), canonical)) throw new Error('Runtime link escapes its installation.')
      const hash = createHash('sha256')
      for await (const block of createReadStream(file)) hash.update(block)
      if (hash.digest('hex') !== entry.hash) throw new Error('Runtime checksum failed: ' + entry.name)
    }
  }))
  return manifest
}

export async function configureInstallation(destination, options = {}, input = process.env) {
  const target = await safeDestination(destination, input, { installedSelf: true }), file = join(target, marker)
  const saved = JSON.parse(await readFile(file, 'utf8'))
  const env = await instanceEnvironment(join(target, 'runtime'), input)
  const current = configuration(source, env)
  if ((await startup(current, 'status')).enabled) throw new Error('Disable automatic startup before changing the workspace configuration.')
  if ((await status(current)).services.some(item => ['running', 'starting', 'stopping'].includes(item.state)))
    throw new Error('Stop this workspace before changing its configuration.')
  const updated = { ...saved }
  for (const [option, key] of [['home', 'workspace'], ['port', 'port'], ['carrierPort', 'carrierPort'], ['origins', 'origins'], ['transport', 'transport'], ['trustProxy', 'trustProxy']])
    if (options[option]) updated[key] = options[option]
  if (!options.yes) {
    updated.workspace = await question('Workspace directory [' + updated.workspace + ']: ') || updated.workspace
    updated.port = await question('API port [' + updated.port + ']: ') || updated.port
    updated.carrierPort = await question('Carrier port [' + updated.carrierPort + ']: ') || updated.carrierPort
  }
  if (!isAbsolute(updated.workspace)) throw new Error('Workspace directory must be absolute.')
  updated.workspace = resolve(updated.workspace)
  updated.port = Number(updated.port); updated.carrierPort = Number(updated.carrierPort)
  await verifyWorkspace(updated.workspace, target)
  configuration(source, { ...input, AIXAND_LOCAL_HOME: updated.workspace, AIXAND_LOCAL_PORT: String(updated.port), AIXAND_LOCAL_CARRIER_PORT: String(updated.carrierPort) })
  if (updated.transport && !['loopback', 'https-proxy'].includes(updated.transport)) throw new Error('Choose loopback or https-proxy transport.')
  if (updated.origins) for (const value of updated.origins.split(',')) {
    const origin = new URL(value.trim())
    if (origin.origin !== value.trim() || !['http:', 'https:'].includes(origin.protocol) || updated.transport === 'https-proxy' && origin.protocol !== 'https:')
      throw new Error('Use exact allowed HTTP(S) origins; HTTPS is required for proxy mode.')
  }
  if (updated.transport === 'https-proxy' && (!updated.origins || !updated.trustProxy)) throw new Error('HTTPS proxy mode needs --origins and --trust-proxy.')
  await writeFile(file + '.new', JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 }); await rename(file + '.new', file)
  console.log(options.json ? JSON.stringify(updated) : 'Server configuration saved. Existing workspace data was preserved.')
  return updated
}

async function registerCommand(destination, input) {
  const bin = join(destination, 'bin'), root = join(destination, 'runtime')
  await mkdir(bin, { recursive: true, mode: 0o700 })
  const command = join(bin, binary('aixand-server'))
  if (process.platform === 'win32') {
    await cp(join(root, 'bin/aixand-server.exe'), command)
    await writeFile(join(bin, 'aixand-server.aixand-command.json'), JSON.stringify({ root: '../runtime', commands: {
      'aixand-server': { program: 'node/node.exe', args: ['@root/server-cli.mjs'] },
    } }, null, 2) + '\n')
    for (const name of await readdir(join(root, 'bin'))) if (/^(?:vcruntime|msvcp|concrt).*\.dll$/i.test(name)) await cp(join(root, 'bin', name), join(bin, name))
    if (input.AIXAND_SKIP_PATH_REGISTRATION !== '1') await addUserPath(bin, input)
  } else {
    await writeFile(command, `#!/bin/sh\nexec ${quote(nodePath(root))} ${quote(join(root, 'server-cli.mjs'))} "$@"\n`, { mode: 0o755 })
    if (input.AIXAND_SKIP_PATH_REGISTRATION !== '1') {
      const directory = join(input.HOME || homedir(), '.local/bin'), link = join(directory, 'aixand-server')
      await mkdir(directory, { recursive: true })
      try {
        const info = await lstat(link)
        if (!info.isSymbolicLink() || !inside(await realpath(link).catch(() => link), destination)) {
          console.log('Kept the existing aixand-server command. Use: ' + command); return command
        }
        await unlink(link)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const { symlink } = await import('node:fs/promises'); await symlink(command, link)
    }
  }
  return command
}

export async function install(destination, options = {}, input = process.env) {
  options = { acceptedLicenses: [], ...options }
  const target = await safeDestination(destination, input)
  console.log('Verifying the Server runtime and included product kit…')
  const manifest = await verifyRuntime(source)
  const previous = existsSync(join(target, marker)) ? JSON.parse(await readFile(join(target, marker), 'utf8')) : null
  const env = previous ? await instanceEnvironment(join(target, 'runtime'), input) : { ...input }
  const config = configuration(source, env)
  const state = await status(config)
  if (state.running || state.services?.some(item => item.state === 'running')) {
    if (!options.yes && !await confirm('Stop this workspace’s services before installation?')) throw new Error('Installation cancelled.')
    await stop(config)
  }
  await verifyWorkspace(config.base, target)
  await mkdir(target, { recursive: true, mode: 0o700 })
  const staged = join(target, '.runtime-' + randomUUID()), retired = join(target, '.previous-' + randomUUID())
  let moved = false, activated = false
  try {
    await cp(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    await verifyRuntime(staged)
    if (existsSync(join(target, 'runtime'))) { await rename(join(target, 'runtime'), retired); moved = true }
    try { await rename(staged, join(target, 'runtime')) }
    catch (error) { if (moved) await rename(retired, join(target, 'runtime')); throw error }
    const record = { ...previous, schema: 1, application: 'org.aixand.server', directory: target,
      build: manifest.build, version: manifest.version || '0.1.0-beta', workspace: config.base, port: config.port, carrierPort: config.carrierPort,
      ...(options.updateTransaction && moved ? { updateBackup: retired.slice(target.length + 1) } : {}) }
    const recordPath = join(target, marker)
    await writeFile(recordPath + '.new', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    await rename(recordPath + '.new', recordPath)
    const command = await registerCommand(target, input)
    activated = true
    console.log('Server application installed: ' + target)
    console.log('Workspace: ' + config.base)
    if (!previous && !options.yes) await configureInstallation(target, options, input)
    if (options.skipSetup && options.installationMode && !previous) {
      await new Promise((ready, fail) => {
        const child = spawn(nodePath(join(target, 'runtime')), [join(target, 'runtime/runtime.mjs'), 'setup', 'choose', JSON.stringify({ mode: options.installationMode, settings: options.settings })], { env: { ...input, AIXAND_LOCAL_HOME: config.base }, stdio: 'inherit', windowsHide: true })
        child.once('error', fail); child.once('exit', code => code === 0 ? ready() : fail(new Error('Installation mode could not be saved. Resume Server setup.')))
      })
    }
    if (!options.skipSetup) {
      const args = [join(target, 'runtime/server-cli.mjs'), 'setup', ...(options.installationMode ? ['--installation-mode', options.installationMode] : []), ...(options.settings ? ['--settings', options.settings] : []), ...(options.managerHomes ? ['--manager-homes', options.managerHomes] : []), ...options.acceptedLicenses.flatMap(value => ['--accept-license', value]), ...(options.yes ? ['--yes'] : [])]
      await new Promise((ready, fail) => {
        const child = spawn(nodePath(join(target, 'runtime')), args, { env: input, stdio: 'inherit', windowsHide: true })
        child.once('error', fail); child.once('exit', code => code === 0 ? ready() : fail(new Error('Server software is installed; setup is unfinished. Resume with ' + command + ' setup.')))
      })
      if (!options.yes && await confirm('Start Aixand Server automatically after you log in?')) {
        const settings = await instanceEnvironment(join(target, 'runtime'), input)
        await startup(configuration(join(target, 'runtime'), settings), 'enable')
        console.log('Automatic startup enabled for your user account. It takes effect at your next login.')
      }
    }
    return { installed: true, directory: target, command, workspace: config.base }
  } catch (error) {
    if (moved && !activated && existsSync(retired)) {
      await rm(join(target, 'runtime'), { recursive: true, force: true, maxRetries: 5 })
      await rename(retired, join(target, 'runtime'))
      await writeFile(join(target, marker), JSON.stringify(previous, null, 2) + '\n', { mode: 0o600 })
    }
    throw error
  } finally {
    await rm(staged, { recursive: true, force: true, maxRetries: 5 })
    if (moved && (!activated || !options.updateTransaction)) await rm(retired, { recursive: true, force: true, maxRetries: 5 })
  }
}

export async function uninstall(options, config) {
  if (!options.confirmed) throw new Error('Uninstall cancelled.')
  validateLeftoverEntries(options.leftoverEntries || [])
  const target = await safeDestination(resolve(config.root, '..'), config.input, { installedSelf: true })
  const receipt = await readFile(join(target, marker))
  const saved = JSON.parse(receipt)
  if (saved.workspace !== config.base) throw new Error('Workspace changed. Refresh uninstall before continuing.')
  if (!options.servicesStopped) await stop(config, { migrate: false })
  if (!options.startupDisabled) {
    const automatic = await startup(config, 'status')
    if (automatic.enabled) await startup(config, 'disable')
  }
  if (process.platform === 'win32' && config.input.AIXAND_SKIP_PATH_REGISTRATION !== '1') await removeUserPath(join(target, 'bin'), config.input)
  const link = join(config.env.HOME, '.local/bin/aixand-server')
  if (process.platform !== 'win32') {
    try { if ((await lstat(link)).isSymbolicLink() && inside(await realpath(link), target)) await unlink(link) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (process.platform === 'win32' && inside(process.execPath, target)) {
    // The console launcher and Node executable are mapped until this command
    // exits. An OS-owned PowerShell helper waits; it never kills a process.
    const log = join(config.input.LOCALAPPDATA || dirname(target), 'Aixand/installer-logs/server-uninstall-' + randomUUID() + '.json')
    const payload = Buffer.from(JSON.stringify({ target, receiptHash: createHash('sha256').update(receipt).digest('hex'), pid: process.pid, log, leftovers: options.leftoverEntries || [] })).toString('base64')
    const script = `$ErrorActionPreference='Stop'
$task=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
function Remove-Owned([string]$item) {
  if (-not [IO.File]::Exists($item) -and -not [IO.Directory]::Exists($item)) { return }
  $attributes=[IO.File]::GetAttributes($item)
  if (($attributes -band [IO.FileAttributes]::Directory) -and -not ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($item)) { Remove-Owned $entry }
    [IO.Directory]::Delete($item)
  } elseif ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($item) }
  else { [IO.File]::SetAttributes($item,($attributes -band (-bnot [IO.FileAttributes]::ReadOnly))); [IO.File]::Delete($item) }
}
try {
  Wait-Process -Id $task.pid -Timeout 60 -ErrorAction SilentlyContinue
  if (Get-Process -Id $task.pid -ErrorAction SilentlyContinue) { throw 'Server command has not exited; software was retained.' }
  $marker=[IO.Path]::Combine($task.target,'${marker}')
  $stream=[IO.File]::OpenRead($marker)
  $hasher=[Security.Cryptography.SHA256]::Create()
  try { $receiptHash=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
  if ($receiptHash -ne $task.receiptHash) { throw 'Installation changed before removal.' }
  $extended=([char]92).ToString()+[char]92+'?'+[char]92+$task.target
  foreach ($part in (@('runtime','bin') + @($task.leftovers))) {
    $path=[IO.Path]::Combine($extended,$part)
    for ($attempt=0; $attempt -lt 30; $attempt++) {
      try { Remove-Owned $path; break } catch { if ($attempt -eq 29) { throw }; Start-Sleep -Milliseconds 200 }
    }
  }
  [IO.File]::Delete([IO.Path]::Combine($extended,'${marker}'))
  if (-not [IO.Directory]::EnumerateFileSystemEntries($extended).GetEnumerator().MoveNext()) { [IO.Directory]::Delete($extended) }
  $result=@{removed=$true;dataRetained=$true}
} catch { $result=@{removed=$false;error=$_.Exception.Message} }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($task.log)) | Out-Null
[IO.File]::WriteAllText($task.log,($result | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
`
    const system = config.input.SystemRoot || config.input.SYSTEMROOT || 'C:/Windows'
    const program = join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const launch = Buffer.from(JSON.stringify({ program, directory: system,
      args: '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64') })).toString('base64')
    // Windows PowerShell can exit before running an encoded command when Node
    // detaches it without a console. Start-Process creates its own hidden host;
    // wait for that launch to finish before allowing this command to exit.
    const starter = `$ErrorActionPreference='Stop'
$launch=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${launch}')) | ConvertFrom-Json
Start-Process -FilePath $launch.program -ArgumentList $launch.args -WorkingDirectory $launch.directory -WindowStyle Hidden -PassThru | Out-Null
`
    const child = spawn(program,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(starter, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true })
    await new Promise((ready, fail) => {
      child.once('error', fail)
      child.once('exit', code => code === 0 ? ready() : fail(new Error('Windows could not start application removal. Application files were retained.')))
    })
    console.log('Application removal will finish after this command exits. Result: ' + log)
    return { deferred: true, log }
  }
  for (const name of ['runtime', 'bin', ...(options.leftoverEntries || [])]) await rm(join(target, name), { recursive: true, force: true, maxRetries: 5 })
  await unlink(join(target, marker))
  if (!(await readdir(target)).length) await rm(target, { recursive: true })
  else if (!options.json) console.log('Retained files in ' + target + ': ' + (await readdir(target)).join(', ') + '. Move them before reinstalling, or use Install to back up or remove them.')
  for (const name of ['runtime', 'bin', marker]) if (existsSync(join(target, name))) throw new Error('Application removal is incomplete: ' + join(target, name))
  if (!options.json) console.log(color('Aixand Server application removed. Unselected components were kept.', 'success'))
  return { removed: true }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log('Aixand Server Setup: install | update | repair | reset | uninstall [--directory ABSOLUTE_PATH] [--configure-later] [--existing-files backup|remove] [--remove-target application|tools|both|everything] [--yes] [--accept-license SHA256]'); return }
  let command = args[0] && !args[0].startsWith('-') ? args.shift() : undefined
  const options = parseOptions(args)
  let destination = defaultDestination()
  const at = options.rest.indexOf('--directory')
  if (at >= 0) { destination = options.rest[at + 1]; options.rest.splice(at, 2) }
  if (!destination || options.rest.length) throw new Error('Use install, update, repair, reset or uninstall, optionally --directory ABSOLUTE_PATH.')
  if (!command) {
    if (options.yes || options.json) throw new Error('Select an explicit installer command for automated use.')
    command = await choose('Aixand Server — choose an action', [
      { value: 'install', label: 'Install' }, { value: 'update', label: 'Update' },
      { value: 'repair', label: 'Repair' }, { value: 'reset', label: 'Reset', detail: 'Remove selected data. Keep software' },
      { value: 'uninstall', label: 'Uninstall', detail: 'Remove application, tools or both' },
      { value: 'status', label: 'Status' }, { value: 'exit', label: 'Exit' },
    ])
  }
  if (command === 'exit') return
  if (['install', 'update', 'repair'].includes(command)) {
    if (!options.yes) destination = await question('Application directory [' + destination + ']: ') || destination
    if (command !== 'install' && options.existingFiles) throw new Error('--existing-files applies to fresh Install or Uninstall only.')
    if (command === 'install') destination = await prepareDestination(destination, options)
    await install(destination, options)
    console.log(options.skipSetup ? 'Resume configuration with aixand-server setup.' : 'Start with aixand-server start, or aixand-server run for an attached terminal.')
  } else if (['reset', 'uninstall', 'status'].includes(command)) {
    await safeDestination(destination, process.env, { allowUnrecognized: command === 'uninstall' })
    const leftoverEntries = existsSync(destination) ? (await readdir(destination)).filter(name => !existsSync(join(destination, marker)) || !['runtime', 'bin', marker].includes(name)) : []
    const env = await instanceEnvironment(join(destination, 'runtime'))
    // Maintenance uses the new verified helper runtime, with the reviewed
    // installation's workspace. A healthy old desktop/backend is unnecessary.
    if (options.home) env.AIXAND_LOCAL_HOME = resolve(options.home)
    const config = configuration(source, env)
    const inventory = await componentInventory(source, env, config.base, destination)
    if (command === 'status') {
      if (options.json) console.log(JSON.stringify(inventory))
      else {
        console.log('Application: ' + (inventory.application?.directory || 'not found'))
        console.log('Workspace: ' + inventory.workspace.path + (inventory.workspace.present ? '' : ' (not found)'))
        for (const tool of inventory.tools.filter(tool => tool.primary)) console.log(tool.name + ': ' + (tool.version || 'version unavailable') + ' · ' + tool.path)
        for (const item of inventory.sharedData) console.log('Shared data: ' + item.paths.join(', '))
        const live = await status(config)
        for (const item of live.services) console.log(item.name + ': ' + item.state)
      }
      return inventory
    }
    const application = applicationAt(destination)
    const storeReceipt = join(inventory.productPrefix, 'installation-receipt.json')
    const privateReceipt = join(config.base, 'software/products/installation-receipt.json')
    if (!application && !leftoverEntries.length && !inventory.found && !existsSync(storeReceipt) && !existsSync(privateReceipt)) {
      console.log(options.json ? JSON.stringify({ removed: false, reason: 'No installation was found in the checked locations.' }) : 'No installation was found in the checked locations.')
      if (!options.yes && await choose('Choose the next action', [{ value: false, label: 'Exit' }, { value: true, label: 'Choose another application path' }])) {
        const path = await question('Application directory: ')
        return main([command, '--directory', path])
      }
      return { removed: false }
    }
    for (const tool of inventory.tools.filter(tool => tool.primary && tool.location === 'external'))
      (options.json ? console.error : console.log)(color('External tool: ' + tool.name + ' · ' + tool.path + '. Its original installer must remove it.', 'warning'))
    // Keep the verified helper runtime for data and tool removal. The installed
    // application path is supplied separately for application removal.
    await cleanup(config, { ...options, applicationPresent: Boolean(application), applicationDirectory: destination, leftoverEntries }, command === 'uninstall' ? 'uninstall' : 'reset')
  } else throw new Error('Choose install, update, repair, reset or uninstall.')
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1 })
