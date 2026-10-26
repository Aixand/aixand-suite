// Human-facing terminal adapter over the same runtime used by Desktop.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { configuration, start, status, stop, doctor } from './runtime.mjs'
import { productStatus, productCommands } from './products.mjs'
import { startup } from './server-startup.mjs'

const execute = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const help = `Aixand Server 0.1.0-beta
Usage: aixand-server COMMAND [OPTIONS]
  setup                 Install required tools and configure the workspace
  configure             Review workspace, ports and network settings
  startup enable|disable|status  Manage automatic startup after user login
  run                   Run attached; Ctrl+C stops this instance
  start | stop | status Manage background services
  logs [server|runner|carrier] [UC LOG OPTIONS]
  doctor                Check installed runtime dependencies
  providers [AGENT ARGS] Run Agent Manager in this workspace
  password              Recover the workspace password locally
  repair                Reinstall/verify the required product kit
  reset                 Review the component cleanup checklist
  uninstall             Remove this application with optional component cleanup
Options: --json, --yes, --accept-license SHA256 (repeatable)
Software updates use the new qualified setup executable. Data is preserved.
`

export async function question(label) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run in an interactive terminal, or supply the explicit automation options.')
  const prompt = createInterface({ input: stdin, output: stdout })
  try { return (await prompt.question(label)).trim() } finally { prompt.close() }
}

export function parseOptions(args) {
  const options = { json: false, yes: false, acceptedLicenses: [], selected: [], rest: [] }
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--json') options.json = true
    else if (value === '--yes') options.yes = true
    else if (value === '--configure-later') options.skipSetup = true
    else if (['--accept-license', '--select', '--home', '--port', '--carrier-port', '--origins', '--transport', '--trust-proxy'].includes(value)) {
      const next = args[++index]
      if (!next || next.startsWith('--')) throw new Error('Missing value for ' + value)
      if (value === '--accept-license') {
        if (!/^[a-f0-9]{64}$/.test(next)) throw new Error('Invalid license digest.')
        options.acceptedLicenses.push(next)
      } else if (value === '--select') options.selected.push(next)
      else options[value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = next
    } else if (value !== '--all') options.rest.push(value)
  }
  return options
}

export async function instanceEnvironment(runtime = root, input = process.env) {
  const file = join(runtime, '..', 'server-installation.json')
  if (!existsSync(file)) return { ...input }
  const saved = JSON.parse(await readFile(file, 'utf8'))
  if (saved.schema !== 1 || !isAbsolute(saved.workspace) || !Number.isInteger(saved.port) || !Number.isInteger(saved.carrierPort))
    throw new Error('Server installation settings are invalid. Run the installer repair operation.')
  return { ...input, AIXAND_LOCAL_HOME: saved.workspace, AIXAND_LOCAL_PORT: String(saved.port),
    AIXAND_LOCAL_CARRIER_PORT: String(saved.carrierPort),
    ...(saved.origins ? { AIXAND_PRODUCTION_ORIGINS: saved.origins } : {}),
    ...(saved.transport ? { AIXAND_PRODUCTION_TRANSPORT: saved.transport } : {}),
    ...(saved.trustProxy ? { AIXAND_PRODUCTION_TRUST_PROXY: saved.trustProxy } : {}) }
}

function child(program, args, env) {
  return new Promise((resolveCode, reject) => {
    const process = spawn(program, args, { env, stdio: 'inherit', windowsHide: true })
    process.once('error', reject)
    process.once('exit', (code, signal) => code === 0 ? resolveCode() : reject(new Error(signal ? 'Command interrupted: ' + signal : 'Command failed (exit ' + code + ').')))
  })
}

async function runtime(args, env, capture = true) {
  if (!capture) return child(process.execPath, [join(root, 'runtime.mjs'), ...args], env)
  return JSON.parse((await execute(process.execPath, [join(root, 'runtime.mjs'), ...args],
    { env, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout)
}

async function auth(command, config, capture = false) {
  const args = [join(root, 'server/dist/auth/cli.js'), command]
  return capture ? JSON.parse((await execute(process.execPath, args, { env: config.env, windowsHide: true })).stdout)
    : child(process.execPath, args, config.env)
}

async function install(config, options) {
  const info = productStatus(root, config.input, config.base)
  if (!info.available) throw new Error('This runtime does not include qualified product installers.')
  for (const row of info.assemblies) console.log(`${row.installed ? 'Ready' : 'Install'}: ${row.name}`)
  const missing = info.licenses.filter(row => !options.acceptedLicenses.includes(row.sha256))
  if (missing.length) {
    if (options.yes) throw new Error('Explicit license acceptance required: ' + missing.map(row => '--accept-license ' + row.sha256).join(' '))
    for (const row of missing) console.log(`\n${row.product}\n${row.text}\nSHA256: ${row.sha256}`)
    if ((await question('Accept these product terms? [y/N] ')).toLowerCase() !== 'y') throw new Error('Installation cancelled.')
    options.acceptedLicenses.push(...missing.map(row => row.sha256))
  }
  const commands = await productCommands(root, config.input, config.base)
  const conflicts = commands.commands.filter(row => row.conflict)
  let terminalPolicy = commands.userPathSupported && !conflicts.length ? 'prefer' : 'keep'
  if (conflicts.length) {
    console.log('\nExisting terminal commands were found:')
    for (const row of conflicts) {
      console.log(`${row.name}\n  Existing: ${row.default?.version || 'version unavailable'} · ${row.default?.path || 'not on PATH'}\n  Aixand: ${row.suiteVersion || row.installedVersion || 'included version'} · ${row.installedPath}`)
    }
    if (commands.userPathSupported && !options.yes) {
      console.log('1. Use existing commands\n2. Use newly installed commands')
      if (await question('Choose [1]: ') === '2') terminalPolicy = 'prefer'
    }
  }
  let done = false, previous = ''
  const watching = (async () => {
    while (!done) {
      try {
        const job = productStatus(root, config.input, config.base).job
        const message = job && `${job.completed.length}/${info.assemblies.length} groups complete · ${job.message}`
        if (message && message !== previous) { console.log(message); previous = message }
      } catch { /* The atomic job record may not exist until installation begins. */ }
      await delay(300)
    }
  })()
  let result
  try {
    result = await runtime(['setup', 'install', JSON.stringify({ acceptedLicenses: options.acceptedLicenses, terminalPolicy, ...(options.repair ? { repair: true } : {}) })], config.input)
  } finally { done = true; await watching }
  console.log('Independent tools are ready. Shared commands remain usable without Aixand.')
  if (result.ucConnection) console.log('Undercurrent connection: ' + result.ucConnection.profile + '. Start Server before connecting to its sessions.')
}

export async function cleanup(config, options, action = 'reset') {
  const plan = await runtime(['cleanup', 'plan'], config.input)
  console.log(plan.notice)
  for (const [index, item] of plan.items.entries()) {
    console.log(`${index + 1}. [${item.available ? ' ' : '-'}] ${item.label}${item.shared ? ' (shared)' : ''}\n   ${item.description}`)
    for (const path of item.paths || []) console.log('   ' + path)
    if (item.recovery) console.log(`   R${index + 1}: ${item.recovery.label}. Saved data is kept.`)
  }
  let selected = options.selected
  if (!options.yes && !selected.length) {
    const choice = await question('Components to remove (comma-separated numbers; Enter keeps all): ')
    if (/^r\d+$/i.test(choice)) {
      const item = plan.items[Number(choice.slice(1)) - 1]
      if (!item?.recovery) throw new Error('Choose a listed CLI restoration action.')
      await runtime(['cleanup', 'restore-provider', JSON.stringify({ provider: item.recovery.provider, revision: plan.revision, confirmed: true })], config.input)
      return cleanup(config, { ...options, selected: [] }, action)
    }
    const indices = choice ? choice.split(',').map(value => Number(value.trim()) - 1) : []
    if (indices.some(index => !Number.isInteger(index) || !plan.items[index]?.available)) throw new Error('Choose available components only.')
    selected = [...new Set(indices)].map(index => plan.items[index].id)
  }
  if (selected.length) {
    if (!options.yes && await question('Permanently remove the selected components? Type REMOVE: ') !== 'REMOVE') throw new Error('Cleanup cancelled.')
    const request = { selected, revision: plan.revision, confirmed: true }
    let result = await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
    if (result.blocked) {
      for (const blocker of result.blockers) {
        console.log(`${blocker.name || 'Application'} — PID ${blocker.pid}`)
        for (const line of [blocker.executable, ...(blocker.paths || []), blocker.reason]) if (line) console.log('  ' + line)
      }
      for (const error of result.errors) console.error(typeof error === 'string' ? error : JSON.stringify(error))
      while (!options.yes && result.canRepairPermissions) {
        for (const item of result.permissionReview) console.log('Administrator access: ' + item.path)
        if ((await question('Allow a Windows administrator job to restore access to these selected provider files, then retry cleanup? [y/N] ')).toLowerCase() !== 'y') break
        const repaired = await runtime(['cleanup', 'repair-permissions', JSON.stringify({ ...request, reviewedPermissions: result.permissionReview })], config.input)
        result = repaired.blocked ? repaired : await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
      }
      if (!options.yes && result.blockers?.length && (await question('Ask these applications to stop and retry? [y/N] ')).toLowerCase() === 'y') {
        await runtime(['cleanup', 'stop-processes', JSON.stringify({ ...request, reviewed: result.blockers.map(({ pid, birth }) => ({ pid, birth })) })], config.input)
        result = await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
      }
    }
    if (result.blocked || result.failed) throw new Error(result.failed || 'Files remain in use. Nothing further was removed; refresh the checklist before retrying.')
    console.log('Removed: ' + result.completed.join(', '))
  }
  if (action === 'uninstall') {
    const { uninstall } = await import('./server-installer.mjs')
    return uninstall({ ...options, confirmed: options.yes || await question('Remove the Aixand Server application? [y/N] ') === 'y' }, config)
  }
  console.log('Unselected components were kept.')
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', ...rest] = args
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return }
  if (command === '--version') { console.log('0.1.0-beta'); return }
  const options = parseOptions(rest), input = await instanceEnvironment()
  let config = configuration(root, input)
  if (command === 'configure') {
    if (options.rest.length) throw new Error('Unknown configure arguments: ' + options.rest.join(' '))
    const { configureInstallation } = await import('./server-installer.mjs')
    return configureInstallation(resolve(root, '..'), options)
  }
  if (command === 'providers') return runtime(['exec', 'agent', ...rest], input, false)
  if (command === 'startup') {
    if (options.rest.length > 1) throw new Error('Choose one startup operation: status, enable or disable.')
    console.log(JSON.stringify(await startup(config, options.rest[0] || 'status'), null, options.json ? 0 : 2)); return
  }
  if (command === 'logs') {
    const name = options.rest.shift() || 'server'
    if (!['server', 'runner', 'carrier'].includes(name)) throw new Error('Choose server, runner, or carrier logs.')
    return runtime(['exec', 'uc', 'logs', 'aixand-local-' + name, ...options.rest], input, false)
  }
  if (options.rest.length) throw new Error('Unknown arguments: ' + options.rest.join(' '))
  let result
  if (command === 'setup' || command === 'repair') {
    if (command === 'repair') {
      options.repair = true
      if ((await status(config)).services.some(item => ['running', 'starting', 'stopping'].includes(item.state))) {
        if (!options.yes && (await question('Stop this workspace’s running work before repairing its tools? [y/N] ')).toLowerCase() !== 'y') throw new Error('Repair cancelled.')
        await stop(config)
      }
    }
    await install(config, options)
    config = configuration(root, input)
    if (command === 'setup' && !(await auth('status', config, true)).configured) {
      if (options.yes) throw new Error('Tools installed. Run aixand-server setup interactively to create the workspace password.')
      await auth('setup', config)
    }
    console.log('Provider setup: aixand-server providers install; then use the provider login command. This can be done later.')
    return
  }
  if (command === 'password') return auth('recover', config)
  if (command === 'reset' || command === 'uninstall') return cleanup(config, options, command)
  if (command === 'start' || command === 'run') {
    if (config.selection.bootstrapping) throw new Error('Run aixand-server setup to install the required independent tools first.')
    if (!(await auth('status', config, true)).configured) throw new Error('Run aixand-server setup to create the workspace password first.')
    result = await start(config)
    if (command === 'run') {
      console.log(`Aixand Server running at ${config.address}. Ctrl+C stops this instance.`)
      await new Promise(resolveSignal => {
        let checking = false
        const finish = () => { clearInterval(timer); process.off('SIGINT', finish); process.off('SIGTERM', finish); resolveSignal() }
        const timer = setInterval(async () => {
          if (checking) return
          checking = true
          try { if ((await status(config)).services.every(item => item.state === 'stopped')) finish() }
          finally { checking = false }
        }, 1000)
        process.once('SIGINT', finish); process.once('SIGTERM', finish)
      })
      result = await stop(config)
    }
  } else if (command === 'stop') result = await stop(config)
  else if (command === 'status') result = await status(config)
  else if (command === 'doctor') result = await doctor(config)
  else throw new Error(help)
  if (options.json) console.log(JSON.stringify(result))
  else console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1 })
