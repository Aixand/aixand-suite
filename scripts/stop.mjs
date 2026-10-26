import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const terminal = state => ['stopped', 'exited', 'failed'].includes(state)

function processInfo(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (fields[0] === 'Z') return undefined
    return { pid: Number(pid), ppid: Number(fields[1]), birth: fields[19],
      args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      cwd: readlinkSync(`/proc/${pid}/cwd`) }
  } catch { return undefined }
}
function snapshotProcesses() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(processInfo).filter(Boolean)
}
function alive(original) { return processInfo(original.pid)?.birth === original.birth }
function signal(original, kind) {
  if (!alive(original)) return
  try { process.kill(original.pid, kind) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function argument(args, key) {
  const index = args.indexOf(key)
  return index < 0 ? undefined : args[index + 1]
}

export async function stopSuite({ root, config, uc, dryRun }) {
  if (process.platform !== 'linux') throw new Error('Suite stop currently requires Linux process inspection.')
  const serverDir = join(root, 'aixand-server')
  const absolute = value => {
    if (value === '~' || value.startsWith('~/')) value = homedir() + value.slice(1)
    return isAbsolute(value) ? value : resolve(serverDir, value)
  }
  const workflowCwd = absolute(config.WORKFLOW_CWD || join(root, 'aixand-ir'))
  const stateDir = absolute(config.XDG_STATE_HOME || join(homedir(), '.local/state'))
  const runnerHome = absolute(config.WORKFLOW_RUNNER_HOME || config.RUNNER_HOME || join(stateDir, 'runner'))
  const carrierDb = absolute(config.CARRIER_DATABASE || join(homedir(), '.aixand/carrier/carrier.db'))
  const carrierUrl = new URL(config.CARRIER_URL || 'http://127.0.0.1:8765')
  const localCarrier = ['localhost', '127.0.0.1', '[::1]'].includes(carrierUrl.hostname)
  const expectedDirs = new Map([
    ['aixand-web', join(root, 'aixand-web')], ['aixand-runner', workflowCwd],
    ['aixand-server', serverDir], ['aixand-carrier', resolve(root, '../carrier')],
  ])
  const failures = []
  let online = false
  try { online = JSON.parse(await uc(['--json', 'daemon', 'status'])).accepting_connections === true } catch { /* Still stop identifiable local workers. */ }

  const selected = []
  if (online) {
    let cursor
    do {
      const page = JSON.parse(await uc(['--json', 'ls', '--projection', 'with-labels', '--page-size', '100', ...(cursor ? ['--cursor', cursor] : [])]))
      for (const row of page.items) {
        if (row.labels?.['suite.root'] && row.labels['suite.root'] !== root) continue
        if (!expectedDirs.has(row.name) && row.labels?.app !== 'aixand-suite') continue
        if (expectedDirs.has(row.name)) {
          const detail = JSON.parse(await uc(['--json', 'inspect', row.name]))
          if (resolve(detail.configuration.working_directory) !== expectedDirs.get(row.name))
            throw new Error(`The uc name ${row.name} belongs to another working directory; it was left untouched.`)
        }
        selected.push(row)
      }
      cursor = page.next_cursor
    } while (cursor)
  } else failures.push('Undercurrent is unreachable; its sessions could not be inspected or cleaned. The daemon was not started or stopped.')

  // Capture process identities before service shutdown reparents detached
  // supervisors. Birth times prevent signalling a subsequently reused PID.
  const processes = snapshotProcesses()
  const workerPaths = ['agent-bridge/main.py', 'recovery-worker/main.py', 'carrier-bridge/main.py'].map(path => join(serverDir, path))
  const carrierProcesses = processes.filter(item => localCarrier && item.args.includes('serve')
    && item.args.some(arg => basename(arg) === 'carrier' || arg === config.AIXAND_CARRIER_BIN)
    && argument(item.args, '--db') === carrierDb
    && Number(argument(item.args, '--port') || 8765) === Number(carrierUrl.port || 80))
  const roots = processes.filter(item => {
    const { args, cwd } = item
    const python = /^python(?:\d+(?:\.\d+)*)?$/.test(basename(args[0] || ''))
    return carrierProcesses.includes(item)
      || args.includes(join(serverDir, 'node_modules/.bin/nest'))
      || args.includes(join(serverDir, 'dist/main')) || args.includes(join(serverDir, 'dist/main.js'))
      || args.includes(join(root, 'aixand-web/node_modules/.bin/vite'))
      || cwd === serverDir && args[0] === 'npm run start:dev'
      || cwd === join(root, 'aixand-web') && args[0] === 'npm run dev'
      || args.includes('serve') && basename(args[0] || '') === 'runner' && argument(args, '--home') === runnerHome
      || python && workerPaths.some(path => args.includes(path))
      || python && [serverDir, workflowCwd].includes(cwd) && argument(args, '-m') === 'agent_manager.supervisor'
      || python && cwd === serverDir && argument(args, '-m') === 'aixand_vox.worker'
  })
  const owned = new Map(roots.map(item => [item.pid, item]))
  let changed
  do {
    changed = false
    for (const item of processes) {
      if (owned.has(item.ppid) && !owned.has(item.pid)) { owned.set(item.pid, item); changed = true }
    }
  } while (changed)
  owned.delete(process.pid)

  // Only stop the systemd unit if its actual MainPID is the configured Carrier.
  // This also suppresses Restart=always for a normal systemd-managed shutdown.
  let carrierUnit = false
  try {
    const { stdout } = await execute('systemctl', ['--user', 'show', 'carrier.service', '--property=MainPID', '--value'], { timeout: 5000 })
    carrierUnit = carrierProcesses.some(item => item.pid === Number(stdout.trim()))
  } catch { /* Standalone Carrier is handled by its verified process identity. */ }

  const rank = row => row.name === 'aixand-web' ? 0 : row.name === 'aixand-runner' ? 1 : row.name === 'aixand-server' ? 2 : row.name === 'aixand-carrier' ? 4 : 3
  selected.sort((a, b) => rank(a) - rank(b))
  for (const row of selected) {
    if (dryRun) {
      console.log(`Would stop and clean ${row.name}.`)
      continue
    }
    try {
      console.log(`Stopping and cleaning ${row.name}…`)
      if (!terminal(row.lifecycle.state)) await uc(['stop', row.name, '--graceful'], 40)
      const deadline = Date.now() + 40_000
      let current
      do {
        const page = JSON.parse(await uc(['--json', 'ls', '--name', row.name, '--page-size', '1']))
        current = page.items.find(item => item.name === row.name)
        if (!current || terminal(current.lifecycle.state)) break
        if (Date.now() >= deadline) throw new Error(`${row.name} has not stopped; its session was not cleaned.`)
        await delay(200)
      } while (true)
      if (current) await uc(['clean', row.name, '--yes'])
    } catch (error) { failures.push(error.message) }
  }
  if (carrierUnit) {
    console.log(`${dryRun ? 'Would stop' : 'Stopping'} systemd carrier.service.`)
    if (!dryRun) {
      try { await execute('systemctl', ['--user', 'stop', 'carrier.service'], { timeout: 30_000 }) }
      catch { failures.push('Could not stop carrier.service. Run: systemctl --user stop carrier.service') }
    }
  }
  const remaining = [...owned.values()].filter(alive)
  if (remaining.length) {
    console.log(`${dryRun ? 'Would stop' : 'Stopping'} ${remaining.length} local Suite process(es), including detached workers.`)
    if (!dryRun) {
      for (const item of remaining) { try { signal(item, 'SIGTERM') } catch (error) { failures.push(`Could not terminate Suite PID ${item.pid}: ${error.code}`) } }
      const deadline = Date.now() + 5000
      while (remaining.some(alive) && Date.now() < deadline) await delay(100)
      for (const item of remaining.filter(alive)) { try { signal(item, 'SIGKILL') } catch (error) { failures.push(`Could not stop Suite PID ${item.pid}: ${error.code}`) } }
      const killDeadline = Date.now() + 3000
      while (remaining.some(alive) && Date.now() < killDeadline) await delay(100)
      for (const item of remaining.filter(alive)) failures.push(`Suite PID ${item.pid} is still running.`)
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  console.log(dryRun ? 'Dry run complete; no services were stopped or cleaned.' : 'Suite stopped and its uc sessions cleaned. Undercurrent is still running; application data was preserved.')
}
