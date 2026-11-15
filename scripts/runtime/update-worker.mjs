import { claimActivation, completeActivation } from './activation.mjs'
// Runs from a private copy of Node outside the application being replaced.
import { readFile, mkdir, cp, rename, rm, chmod, statfs, readdir, lstat, open } from 'node:fs/promises'
import { existsSync, createReadStream } from 'node:fs'
import { dirname, join, resolve, win32 } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { atomicJson, verifyArtifact, verifyRelease, componentSelectionSnapshot, productSelectionSnapshot } from './updates.mjs'

const execute = promisify(execFile)
const need = (condition, message) => { if (!condition) throw new Error(message) }
const nodeAt = root => join(root, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node')
export function runtimeCommandTimeout(args, platform = process.platform) {
  // Revalidating the complete product kit can take more than twenty minutes
  // on Windows, especially while antivirus scans the installed Python files.
  return platform === 'win32' && args[0] === 'setup' && args[1] === 'install' ? 60 * 60_000 : 20 * 60_000
}
export function sameInstallationPath(left, right, platform = process.platform) {
  if (platform !== 'win32') return resolve(left) === resolve(right)
  const normalize = value => win32.resolve(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase()
  return normalize(left) === normalize(right)
}
export function desktopLaunch(job) {
  return { program: job.application, args: [], options: { env: { ...job.env, AIXAND_LOCAL_HOME: job.workspace,
    AIXAND_LOCAL_PORT: String(job.port), AIXAND_LOCAL_CARRIER_PORT: String(job.carrierPort) }, detached: true, stdio: 'ignore', windowsHide: true } }
}
export function nsisLaunch(file, destination) {
  need(!/["\r\n\0]/.test(file + destination), 'The Windows installation path contains unsupported characters.')
  // NSIS requires /D= to be last and unquoted even when its path has spaces.
  // Supply the quoted executable token separately, without a command shell.
  return { file, args: ['/S', '/UPDATE', '/D=' + destination], options: { argv0: '"' + file + '"', windowsVerbatimArguments: true } }
}
async function installNsis(file, destination, env) {
  const plan = nsisLaunch(file, destination)
  const child = spawn(plan.file, plan.args, { ...plan.options, env, stdio: 'ignore', windowsHide: true })
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error('Windows setup timed out. Review its recovery files.')) }, 30 * 60_000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? ready() : fail(new Error('Windows setup exited with code ' + code + '.')) })
  })
}
export async function snapshotDatabases(workspace, destination) {
  const excluded = new Set(['updates', 'agents', 'cache', 'tools', 'scratch', 'software', 'node_modules', '.git'])
  const records = []
  async function digest(file) {
    const hash = createHash('sha256'); let size = 0
    for await (const block of createReadStream(file)) { hash.update(block); size += block.length }
    return { size, sha256: hash.digest('hex') }
  }
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue
      const name = relative ? relative + '/' + entry.name : entry.name, file = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(file, name); continue }
      if (!entry.isFile() || !/\.(db|sqlite|sqlite3)$/.test(entry.name)) continue
      const header = Buffer.alloc(16), handle = await open(file, 'r')
      try { await handle.read(header, 0, 16, 0) } finally { await handle.close() }
      if (header.toString() !== 'SQLite format 3\0') continue
      for (const suffix of ['', '-wal', '-shm']) {
        const source = file + suffix
        if (!existsSync(source)) continue
        need(!(await lstat(source)).isSymbolicLink(), 'A database backup path is redirected.')
        const before = await digest(source), target = join(destination, name + suffix)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await cp(source, target); await chmod(target, 0o600)
        const copied = await digest(target)
        need(before.sha256 === copied.sha256, 'A workspace database is still changing. Stop its other consumers before updating.')
        records.push({ file: name + suffix, ...copied })
      }
    }
  }
  await visit(workspace)
  for (const row of records) need((await digest(join(workspace, row.file))).sha256 === row.sha256, 'Workspace databases changed during backup. Stop their other consumers before updating.')
  await atomicJson(join(destination, 'snapshot.json'), { schema: 1, method: 'offline-copy', createdAt: Date.now(), files: records })
  return records
}
export async function runUpdate(jobFile) {
  const job = JSON.parse(await readFile(jobFile, 'utf8')), directory = dirname(jobFile)
  const stateFile = join(job.config.updateDirectory, 'state.json')
  let state = JSON.parse(await readFile(stateFile, 'utf8'))
  need(state.job && resolve(state.job) === resolve(jobFile) && state.operation === job.operation && state.phase === 'preparing' && !state.operationPid, 'Obsolete native update job refused.')
  const authority = await claimActivation(job.workspace, job.operation, 'native')
  await atomicJson(join(directory, 'lease.json'), { pid: process.pid })
  const save = async (phase, message) => { Object.assign(state, { phase, message, operationPid: process.pid }); await atomicJson(stateFile, state) }
  const env = { ...job.env, AIXAND_ACTIVATION_OWNER: authority, AIXAND_ACTIVATION_OPERATION: job.operation, AIXAND_LOCAL_HOME: job.workspace, AIXAND_LOCAL_PORT: String(job.port), AIXAND_LOCAL_CARRIER_PORT: String(job.carrierPort),
    AIXAND_UPDATE_STATE_DIR: job.config.updateDirectory }
  const run = (program, args, timeout = 180_000) => execute(program, args, { env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })
  const runtime = (root, ...args) => run(nodeAt(root), [join(root, 'runtime.mjs'), ...args], runtimeCommandTimeout(args))
  let backup, destination, replaced = false, newRuntimeStarted = false
  try {
    const release = verifyRelease(job.envelope, job.trust, { product: job.product, floor: job.sequence })
    need(release.sequence === job.sequence && Object.values(release.artifacts).some(item => JSON.stringify(item) === JSON.stringify(job.artifact)), 'The reviewed update package changed.')
    await verifyArtifact(job.packageFile, job.artifact)
    const old = JSON.parse(await readFile(join(job.root, 'manifest.json'), 'utf8'))
    need(old.build === job.installedBuild, 'The installed application changed. Review the update again.')
    const selection = await componentSelectionSnapshot(job.workspace)
    const productSelection = await productSelectionSnapshot(job.workspace)
    need(productSelection.digest === (job.productSelectionDigest ?? null), 'The selected tools changed. Review the application update again.')
    need(Object.values(productSelection.selection?.assemblies || {}).every(item => item.compatibleBuilds?.includes(job.artifact.build)), 'Selected tools are not qualified for the new application build.')
    if (productSelection.selection) await atomicJson(join(directory, 'previous-product-selection.json'), productSelection)
    need(selection.digest === (job.componentSelectionDigest ?? null), 'The component selection changed. Review the application update again.')
    if (selection.selection) {
      const snapshot = join(directory, 'previous-component-selection.json')
      await atomicJson(snapshot, selection)
      state.componentSelectionBackup = snapshot
    }
    await save('preparing', 'Checking the installation and waiting for Desktop to close.')
    if (job.parentPid) {
      let alive = true
      for (let index = 0; index < 120 && alive; index++) {
        try { process.kill(job.parentPid, 0); await delay(500) } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false }
      }
      need(!alive, 'Desktop did not close. Close it and retry the update.')
    }
    // Recheck work immediately before shutdown; the reviewed plan can become stale.
    const check = await run(nodeAt(job.root), [join(job.root, 'runtime.mjs'), 'updates', 'plan'])
    need(JSON.parse(check.stdout).sessions.length === 0, 'New workspace sessions started. Finish them before updating.')
    need((await componentSelectionSnapshot(job.workspace)).digest === selection.digest, 'The component selection changed before shutdown. Review the application update again.')
    need((await productSelectionSnapshot(job.workspace)).digest === productSelection.digest, 'The selected tools changed before shutdown. Review the application update again.')
    await runtime(job.root, 'prepare-update')
    await runtime(job.root, 'stop')
    await delay(1500) // Allow attached Server supervisors to observe shutdown and exit.
    await save('preparing', 'Saving workspace databases before the new runtime can migrate them.')
    const databaseBackup = join(directory, 'databases')
    await snapshotDatabases(job.workspace, databaseBackup)
    state.databaseBackup = databaseBackup
    const startupFile = join(job.root, '..', 'server-installation.json')
    if (job.product === 'aixand-server') {
      need(existsSync(startupFile), 'The Server installation owner could not be verified.')
      await chmod(job.packageFile, 0o700)
      await save('installing', 'Installing the verified Server release. Workspace data is retained.')
      await run(job.packageFile, ['update', '--directory', resolve(job.root, '..'), '--yes', '--configure-later', '--update-transaction'], 30 * 60_000)
      const record = JSON.parse(await readFile(startupFile, 'utf8'))
      backup = record.updateBackup ? join(dirname(job.root), record.updateBackup) : null
      destination = job.root; replaced = true
    } else if (job.artifact.kind === 'nsis') {
      destination = dirname(job.application)
      need(sameInstallationPath(job.root, join(destination, 'runtime')), 'Desktop runtime does not match its installation.')
      const backupCandidate = join(directory, 'previous-application')
      const disk = await statfs(directory)
      need(Number(disk.bavail) * Number(disk.bsize) > job.artifact.size * 5, 'Free more disk space before updating Desktop.')
      await save('preparing', 'Saving the previous Desktop software for recovery.')
      await cp(destination, backupCandidate, { recursive: true, verbatimSymlinks: true })
      backup = backupCandidate
      await save('installing', 'Installing the verified Desktop release.')
      replaced = true
      await installNsis(job.packageFile, destination, env)
    } else if (job.artifact.kind === 'macos-app') {
      destination = resolve(job.application, '../../..')
      need(destination.endsWith('.app') && resolve(job.root).startsWith(destination + '/Contents/Resources/'), 'Desktop application ownership could not be verified.')
      const stage = join(directory, 'application'); await mkdir(stage)
      await run('/usr/bin/tar', ['-xzf', job.packageFile, '-C', stage])
      const entries = await readdir(stage)
      need(entries.length === 1 && entries[0].endsWith('.app') && !(await lstat(join(stage, entries[0]))).isSymbolicLink(), 'Invalid macOS application update.')
      const incoming = join(stage, entries[0])
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming])
      const manifest = JSON.parse(await readFile(join(incoming, 'Contents/Resources/runtime/manifest.json'), 'utf8'))
      need(manifest.build === job.artifact.build, 'The downloaded application has the wrong runtime identity.')
      backup = destination + '.previous-' + job.sequence
      need(!existsSync(backup), 'A previous update backup already exists. Review it before retrying.')
      await save('installing', 'Replacing Desktop. Workspace data is retained.')
      await rename(destination, backup)
      try { await cp(incoming, destination, { recursive: true, verbatimSymlinks: true }); replaced = true }
      catch (error) { await rm(destination, { recursive: true, force: true }); await rename(backup, destination); backup = null; throw error }
    } else {
      // Respect system package ownership. Polkit displays the OS authorization UI.
      const program = job.artifact.kind === 'deb' ? '/usr/bin/apt-get' : '/usr/bin/dnf'
      need(existsSync('/usr/bin/pkexec') && existsSync(program), 'Use your system package manager to install the downloaded update.')
      await save('installing', 'Approve the system package manager to install this update.')
      await run('/usr/bin/pkexec', [program, 'install', '-y', job.packageFile], 30 * 60_000)
      replaced = true
    }
    const installed = JSON.parse(await readFile(join(job.root, 'manifest.json'), 'utf8'))
    need(installed.build === job.artifact.build && installed.releaseSequence === (job.artifact.releaseSequence || job.sequence), 'The installed update failed identity verification. The previous software was retained where supported.')
    if (backup && (job.product === 'aixand-server' || job.artifact.kind === 'macos-app')) {
      // Keep recovery software with workspace update data, so application-only
      // uninstallation cannot leave an old runnable installation behind.
      const retained = join(directory, job.product === 'aixand-server' ? 'previous-runtime' : 'previous-application.app')
      try { await rename(backup, retained) }
      catch (error) {
        if (error.code !== 'EXDEV') throw error
        await cp(backup, retained, { recursive: true, verbatimSymlinks: true })
        await rm(backup, { recursive: true })
      }
      backup = retained; state.backup = backup
      await save('installing', 'Previous software and workspace database snapshots are retained for recovery.')
      if (job.product === 'aixand-server') {
        const record = JSON.parse(await readFile(startupFile, 'utf8')); delete record.updateBackup
        await atomicJson(startupFile, record)
      }
    }
    // Selections can pin the old runtime ABI. Use the new package baseline;
    // keep the exact old selection and immutable objects for reviewed recovery.
    need((await componentSelectionSnapshot(job.workspace)).digest === selection.digest, 'The component selection changed during installation; inspect recovery before starting the new runtime.')
    need((await productSelectionSnapshot(job.workspace)).digest === productSelection.digest, 'The selected tools changed during installation; inspect recovery before starting the new runtime.')
    if (selection.selection) {
      await atomicJson(join(job.workspace, 'config/component-selection.json'), { schema: 1, components: {} })
      state.resetComponents = selection.components
    }
    await save('restarting', 'Verifying the updated tools and workspace.')
    // Consent is bound to the signed release and checked again by the product engine.
    const priorJob = JSON.parse(await readFile(join(job.workspace, 'config/product-installation.json'), 'utf8').catch(() => 'null'))
    await runtime(job.root, 'setup', 'install', JSON.stringify({ acceptedLicenses: job.acceptedLicenses, repair: true,
      connectionVerification: 'configuration',
      terminalPolicy: priorJob?.terminal?.policy === 'prefer' ? 'prefer' : 'keep' }))
    if (job.wasRunning) { newRuntimeStarted = true; await runtime(job.root, 'start') }
    if (job.product === 'aixand-desktop') {
      // Launch the actual bundle executable on macOS as well. LaunchServices
      // can discard a custom workspace/HOME/CA environment when using `open`.
      const launch = desktopLaunch(job)
      Object.assign(launch.options.env, { AIXAND_ACTIVATION_OPERATION: job.operation, AIXAND_ACTIVATION_OWNER: authority })
      const child = spawn(launch.program, launch.args, launch.options)
      await new Promise((ready, fail) => { child.once('spawn', ready); child.once('error', fail) }); child.unref()
      state.relaunchedPid = child.pid
    }
    // Keep one previous release; cleanup can be retried without invalidating a successful update.
    state.backup = backup || state.backup || null; state.completedAt = Date.now(); state.error = null
    await save('complete', 'Update installed and verified.')
    await completeActivation(job.workspace, job.operation)
  } catch (error) {
    // Once the new runtime has run, automatic binary rollback could contradict
    // database migrations. Keep recovery files and report the exact state.
    if (!replaced && job.wasRunning && !newRuntimeStarted) await runtime(job.root, 'start').catch(() => {})
    state.error = error.message; state.backup = backup || state.backup || null
    await save('failed', 'Update could not finish: ' + error.message)
  } finally {
    if (job.taskName && /^AixandUpdate-[a-f0-9-]+$/.test(job.taskName)) {
      const program = join(job.env.SystemRoot || job.env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      await run(program, ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName '${job.taskName}' -Confirm:$false`]).catch(() => {})
    }
  }
}
if (import.meta.main) runUpdate(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
