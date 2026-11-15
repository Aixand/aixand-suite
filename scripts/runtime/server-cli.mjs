// Human-facing terminal adapter over the same runtime used by Desktop.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { configuration, start, status, stop, doctor } from './runtime.mjs'
import { productStatus, productCommands } from './products.mjs'
import { startup } from './server-startup.mjs'
import { choose, confirm, color } from './terminal-ui.mjs'
import { removalChoices, removalDataChoices } from './component-inventory.mjs'

const execute = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
async function serverVersion() {
  for (const file of [join(root, 'manifest.json'), join(root, 'server/package.json'),
    join(root, '../../apps/server/package.json')]) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8')).version
      if (typeof value === 'string' && value) return value
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error('Server version metadata is missing.')
}
const help = version => `Aixand Server ${version}
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
  update check|status|plan|download|install  Manage selected components (--select ID)
  update daily|automatic-download on|off  Set component update preferences
  product-update check|status|plan|download|install  Manage tools (--select ID)
  application-update check|status|download|plan|install  Update the native package
  reset                 Review the component cleanup checklist
  uninstall             Remove this application with optional component cleanup
Options: --installation-mode shared|isolated, --settings fresh|copy|reuse, --json, --yes, --accept-license SHA256
Removal: --remove-target application|tools|both|everything, --existing-files backup|remove, --purge, --select COMPONENT, --all
Component installation requires --yes and --restart-consent for unattended restarts.
Update installation preserves workspace data. Running agent sessions must finish first.
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
    else if (value === '--restart-consent') options.restartConsent = true
    else if (value === '--purge') options.purge = true
    else if (value === '--all') options.all = true
    else if (value === '--configure-later') options.skipSetup = true
    else if (value === '--update-transaction') options.updateTransaction = true
    else if (['--accept-license', '--select', '--home', '--port', '--carrier-port', '--origins', '--transport', '--trust-proxy', '--installation-mode', '--settings', '--remove-target', '--existing-files'].includes(value)) {
      const next = args[++index]
      if (!next || next.startsWith('--')) throw new Error('Missing value for ' + value)
      if (value === '--accept-license') {
        if (!/^[a-f0-9]{64}$/.test(next)) throw new Error('Invalid license digest.')
        options.acceptedLicenses.push(next)
      } else if (value === '--select') options.selected.push(next)
      else options[value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = next
    } else if (value !== '--all') options.rest.push(value)
  }
  if (options.installationMode && !['shared', 'isolated'].includes(options.installationMode)) throw new Error('Choose --installation-mode shared or isolated.')
  if (options.settings && !['fresh', 'copy', 'reuse'].includes(options.settings)) throw new Error('Choose --settings fresh, copy, or reuse.')
  if (options.removeTarget && !['application', 'tools', 'both', 'everything'].includes(options.removeTarget)) throw new Error('Choose --remove-target application, tools or both, or everything.')
  if (options.existingFiles && !['backup', 'remove'].includes(options.existingFiles)) throw new Error('Choose --existing-files backup or remove.')
  if (options.removeTarget === 'everything' && options.selected.length) throw new Error('Everything cannot be combined with --select.')
  if (options.purge && options.selected.length) throw new Error('With --select, select data components explicitly. Do not add --purge.')
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

async function chooseInstallation(config, options) {
  const info = await runtime(['setup', 'info'], config.input)
  if (!info.selectionRequired) {
    if (options.installationMode && options.installationMode !== info.setupMode) throw new Error('Keep the saved installation mode during setup or repair.')
    return configuration(root, config.input)
  }
  const found = await runtime(['setup', 'discover'], config.input)
  for (const tool of found.tools.filter(tool => tool.primary))
    console.log(`${tool.name}: ${tool.path} · ${tool.version || 'version unavailable'}${tool.compatible === false ? ' · incompatible' : ''}`)
  for (const item of found.data) console.log('Existing settings or data: ' + item.path)
  let mode = options.installationMode
  if (!mode && !options.yes) mode = await choose('Choose an installation mode', [
    { value: 'isolated', label: 'Isolated installation (recommended)', detail: 'Private tools, settings and data' },
    { value: 'shared', label: 'Shared installation', detail: 'Reuse compatible tools; install missing tools independently' },
  ])
  mode ||= 'isolated'
  let settings = options.settings
  if (!settings && !options.yes && found.data.length) settings = await choose('Choose how to use existing settings', mode === 'isolated' ? [
    { value: 'fresh', label: 'Start with empty settings', detail: 'Keep existing external settings unchanged' },
    ...(found.copyableSettings?.length ? [{ value: 'copy', label: 'Copy provider definitions', detail: 'Can include credentials and external paths. Keep live databases separate' }] : []),
  ] : [
    { value: 'reuse', label: 'Use current shared defaults', detail: 'Reuse the selected shared manager roots' },
  ])
  settings ||= mode === 'isolated' ? 'fresh' : 'reuse'
  if (found.issue && mode === 'shared') throw new Error(found.issue)
  const plan = await runtime(['setup', 'choose', JSON.stringify({ mode, settings })], config.input)
  for (const row of plan.actions || []) console.log(row.name + ': ' + row.action + (row.path ? ' · ' + row.path : ''))
  if (plan.settingsReport) console.log(plan.settingsReport)

  return configuration(root, config.input)
}

async function install(config, options) {
  const info = productStatus(root, config.input, config.base)
  if (!info.available) throw new Error('This runtime does not include qualified product installers.')
  for (const row of info.assemblies) console.log(`${row.installed ? 'Ready' : 'Install or update'}: ${row.name} · current: ${[...new Set(row.currentVersions || [])].join(', ') || 'not installed'} · required: ${[...new Set(row.versions)].join(', ')}`)
  const missing = info.licenses.filter(row => !options.acceptedLicenses.includes(row.sha256))
  if (missing.length) {
    if (options.yes) throw new Error('Explicit license acceptance required: ' + missing.map(row => '--accept-license ' + row.sha256).join(' '))
    for (const row of missing) console.log(`\n${row.product}\n${row.text}\nSHA256: ${row.sha256}`)
    if (!await confirm('Accept these product terms?')) throw new Error('Installation cancelled.')
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
      terminalPolicy = await choose('Choose terminal commands', [{ value: 'keep', label: 'Keep existing commands' }, { value: 'prefer', label: 'Use installed commands' }])
    }
  }
  let done = false, previous = ''
  if (!options.yes && !await confirm(options.repair ? 'Repair the listed tools? External tools will be checked.' : 'Apply this tool installation plan?')) throw new Error('Installation cancelled.')
  const watching = (async () => {
    while (!done) {
      try {
        const job = productStatus(root, config.input, config.base).job
        const message = job && `${job.completed.length}/${info.assemblies.length} groups complete · ${job.message}`
        if (message && message !== previous) { console.log(color(message, job.status === 'complete' ? 'success' : job.status === 'error' ? 'error' : 'info')); previous = message }
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

export function componentSelection(choice, items) {
  const value = choice.trim()
  if (!value) return []
  if (value === '0') return items.filter(item => item.available).map(item => item.id)
  const values = value.split(',').map(item => item.trim())
  if (values.includes('0')) throw new Error('Use 0 by itself to select all available components.')
  if (values.some(item => !/^[1-9]\d*$/.test(item))) throw new Error('Choose available component numbers, or 0 for all.')
  const indices = values.map(item => Number(item) - 1)
  if (indices.some(index => !Number.isSafeInteger(index) || !items[index]?.available)) throw new Error('Choose available components only.')
  return [...new Set(indices)].map(index => items[index].id)
}

export async function cleanup(config, options, action = 'reset') {
  const log = options.json ? (...values) => console.error(...values) : (...values) => console.log(...values)
  const plan = await runtime(['cleanup', 'plan'], config.input)
  const groups = removalChoices(plan.items)
  if (action === 'reset') groups.data = groups.data.filter(item => !item.requires?.length)
  const recoveries = plan.items.filter(item => item.recovery)
  if (recoveries.length && !options.yes && !options.selected.length && !options.all && !options.purge) {
    const recovery = await choose('Choose a maintenance action', [
      { value: null, label: 'Continue to removal choices' },
      ...recoveries.map(item => ({ value: item, label: item.recovery.label })),
    ])
    if (recovery) {
      if (!await confirm(recovery.recovery.label + '?')) throw new Error('Repair cancelled.')
      const result = await runtime(['cleanup', 'restore-provider', JSON.stringify({ provider: recovery.recovery.provider, revision: plan.revision, confirmed: true })], config.input)
      log('Provider command restored. Run maintenance again to review removal.')
      if (options.json) console.log(JSON.stringify(result))
      return result
    }
  }
  const applicationPresent = options.applicationPresent ?? existsSync(join(config.root, '..', 'server-installation.json'))
  const leftoverEntries = options.leftoverEntries || (applicationPresent ? (await readdir(resolve(config.root, '..'))).filter(name => !['runtime', 'bin', 'server-installation.json'].includes(name)) : [])
  let target = options.removeTarget || (action === 'uninstall' ? 'application' : 'tools')
  if (!options.yes && action === 'uninstall' && !options.removeTarget) {
    const choices = []
    if (applicationPresent) choices.push({ value: 'application', label: 'Remove Aixand application' })
    if (groups.software.length) choices.push({ value: 'tools', label: 'Remove tools' })
    if (applicationPresent && groups.software.length) choices.push({ value: 'both', label: 'Remove application and tools' })
    if (!choices.length && groups.data.length) choices.push({ value: 'tools', label: 'Remove remaining settings and data' })
    if (choices.length || leftoverEntries.length || groups.data.length) choices.push({ value: 'everything', label: 'Everything managed by Aixand', detail: 'Application, managed tools, settings and data' })
    if (!choices.length) { log('No installation was found in the checked locations.'); if (options.json) console.log(JSON.stringify({ removed: false })); return { removed: false } }
    target = await choose('What do you want to remove?', choices)
  }
  const removeApplication = action === 'uninstall' && ['application', 'both', 'everything'].includes(target) && (target !== 'everything' || applicationPresent)
  const applicationDirectory = options.applicationDirectory || resolve(config.root, '..')
  const applicationConfig = { ...config, root: join(applicationDirectory, 'runtime') }
  if (removeApplication && !applicationPresent) throw new Error('No application was found. Choose another path or remove tools only.')
  if (target === 'everything' && action !== 'uninstall') throw new Error('Everything is available only with Uninstall.')
  let deleteLeftovers = false
  if (action === 'uninstall' && leftoverEntries.length && ['application', 'both', 'everything'].includes(target)) {
    log('Additional files in application directory: ' + applicationDirectory)
    for (const name of leftoverEntries) log('  ' + name)
    if (options.existingFiles === 'backup') throw new Error('For Uninstall, omit --existing-files to keep leftovers or use --existing-files remove.')
    deleteLeftovers = options.existingFiles === 'remove' || (!options.yes && await choose('What should happen to these additional application files?', [
      { value: false, label: 'Keep these files' },
      { value: true, label: 'Delete these files too', detail: 'Permanent removal' },
    ]))
  }
  let selected = [...options.selected]
  if (options.all || target === 'everything') selected = (action === 'reset' ? groups.data : [...(target === 'application' ? [] : groups.software), ...removalDataChoices(groups.data, target)]).map(item => item.id)
  if (!selected.length && !options.all && target !== 'everything') {
    if (['tools', 'both'].includes(target) && action === 'uninstall') {
      const software = groups.software
      selected = options.yes ? software.map(item => item.id) : software.length ? await choose('Select tools to remove', software.map(item => ({ value: item.id, label: item.label, detail: item.shared ? 'Shared with other applications' : 'Private to Aixand' })), { multiple: true }) : []
    }
    let purge = options.purge
    if (!options.yes && purge === undefined) purge = await choose('What should happen to settings and data?', [
      { value: false, label: 'Keep settings and data' },
      { value: true, label: 'Delete selected settings and data', detail: 'Permanent removal' },
    ])
    if (purge) {
      const data = action === 'reset' ? groups.data : removalDataChoices(groups.data, target)
      selected.push(...(options.yes ? data.map(item => item.id) : data.length ? await choose('Select data to delete', data.map(item => ({ value: item.id, label: item.label, detail: item.paths.join(', ') })), { multiple: true }) : []))
    }
  }
  // Native provider logins belong to the user, not to Aixand.
  if (target === 'everything') selected = selected.filter(id => !id.startsWith('native:'))
  selected = [...new Set(selected)]
  if (action === 'reset' && selected.some(id => groups.software.some(item => item.id === id))) throw new Error('Reset keeps installed software. Use Uninstall to remove tools.')
  log(color('Removal review', 'warning'))
  if (removeApplication) log('REMOVE application: ' + applicationDirectory)
  for (const name of leftoverEntries) log((deleteLeftovers ? 'REMOVE ' : 'KEEP ') + join(applicationDirectory, name))
  for (const item of plan.items) {
    log((selected.includes(item.id) ? 'REMOVE ' : 'KEEP ') + item.label)
    for (const path of item.paths || []) log('  ' + path)
  }
  if (!selected.length && !removeApplication && !deleteLeftovers) { log('Nothing selected. No changes made.'); if (options.json) console.log(JSON.stringify({ removed: false })); return { removed: false } }
  const disableStartup = applicationPresent && (removeApplication || selected.some(id => ['workspace', 'private-products', 'private-tool-data'].includes(id) || id.startsWith('product:')))
  if (disableStartup) log('Automatic startup for this application will be disabled if it is enabled.')
  if (!options.yes && !await confirm('Apply this removal plan?')) throw new Error('Removal cancelled.')
  if (disableStartup) {
    const automatic = await startup(applicationConfig, 'status')
    if (automatic.enabled) await startup(applicationConfig, 'disable')
  }
  if (removeApplication) {
    log('Stopping application services...')
    await stop(config)
  }
  let result = { completed: [], kept: plan.items.map(item => item.id) }
  if (selected.length) {
    log('Checking processes and removing selected components...')
    const request = { selected, revision: plan.revision, confirmed: true }
    result = await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
    if (result.blocked) {
      for (const blocker of result.blockers || []) log(color('IN USE: ' + blocker.name + ' · PID ' + blocker.pid + ' · ' + blocker.executable, 'warning'))
      for (const error of result.errors || []) console.error(typeof error === 'string' ? error : JSON.stringify(error))
      if (!options.yes && result.canRepairPermissions && await confirm('Allow an administrator job to repair the listed file permissions?')) {
        const repaired = await runtime(['cleanup', 'repair-permissions', JSON.stringify({ ...request, reviewedPermissions: result.permissionReview })], config.input)
        result = repaired.blocked ? repaired : await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
      }
      if (!options.yes && result.blockers?.length && await confirm('Stop the listed processes and continue?')) {
        await runtime(['cleanup', 'stop-processes', JSON.stringify({ ...request, reviewed: result.blockers.map(({ pid, birth }) => ({ pid, birth })) })], config.input)
        result = await runtime(['cleanup', 'apply', JSON.stringify(request)], config.input)
      }
    }
    if (result.blocked || result.failed) {
      console.error('Completed: ' + (result.completed || []).join(', '))
      throw new Error(result.failed || 'Selected components remain in use. Removal is incomplete.')
    }
    log(color('Removed: ' + result.completed.join(', '), 'success'))
  }
  if (removeApplication) {
    const { uninstall } = await import('./server-installer.mjs')
    const applicationResult = await uninstall({ confirmed: true, servicesStopped: true, startupDisabled: true, json: options.json, leftoverEntries: deleteLeftovers ? leftoverEntries : [] }, applicationConfig)
    result.application = applicationResult
  }
  if (deleteLeftovers && !removeApplication) {
    const { removeApplicationLeftovers } = await import('./server-installer.mjs')
    await removeApplicationLeftovers(applicationDirectory, leftoverEntries, config.input)
    result.leftoversRemoved = true
  }
  if (options.json) console.log(JSON.stringify(result))
  return result
}

export async function componentUpdate(config, options, invoke = (action, request = {}) => runtime(['component-updates', action, JSON.stringify(request)], config.input), selectionKey = 'components') {
  const action = options.rest[0] || 'status'
  if (['daily', 'automatic-download'].includes(action)) {
    if (options.rest.length !== 2 || !['on', 'off'].includes(options.rest[1])) throw new Error('Use update ' + action + ' on|off.')
    return invoke('settings', { [action === 'daily' ? 'daily' : 'automaticDownload']: options.rest[1] === 'on' })
  }
  if (options.rest.length > 1 || !['status', 'check', 'plan', 'download', 'install'].includes(action)) throw new Error('Choose status, check, plan, download or install.')
  if (!['plan', 'download', 'install'].includes(action)) return invoke(action)
  if (!options.selected.length) throw new Error('Select components explicitly with --select ID for plan, download or install.')
  const plan = await invoke('plan', { [selectionKey]: options.selected })
  if (action === 'plan') return plan
  if (action === 'download') return invoke('download')
  console.log(JSON.stringify(plan, null, 2))
  let acceptedLicenses = [...options.acceptedLicenses]
  if (plan.licenses.some(item => !acceptedLicenses.includes(item.sha256))) {
    if (options.yes) throw new Error('Explicit license acceptance required: ' + plan.licenses.map(item => '--accept-license ' + item.sha256).join(' '))
    if (!await confirm('Accept every displayed component and companion licence?')) throw new Error('Update cancelled.')
    acceptedLicenses = plan.licenses.map(item => item.sha256)
  }
  let restartConsent = options.restartConsent === true
  if (plan.restartRequired && !restartConsent) {
    if (options.yes) throw new Error('Explicit --restart-consent is required for the displayed restart plan.')
    restartConsent = await confirm('Stop and restart the affected services shown in this plan?')
    if (!restartConsent) throw new Error('Update cancelled.')
  }
  if (!options.yes && !await confirm('Install the complete displayed component and companion plan?')) throw new Error('Update cancelled.')
  return invoke('install', { confirmed: true, revision: plan.revision, restartConsent, acceptedLicenses })
}

export async function main(args = process.argv.slice(2)) {
  let [command, ...rest] = args
  if (!command) {
    if (!stdin.isTTY || !stdout.isTTY) command = 'help'
    else command = await choose('Aixand Server — choose an action', [
      { value: 'setup', label: 'Install or finish setup' }, { value: 'repair', label: 'Repair' },
      { value: 'reset', label: 'Reset', detail: 'Delete selected data. Keep software' },
      { value: 'uninstall', label: 'Uninstall' }, { value: 'status', label: 'Status' }, { value: 'exit', label: 'Exit' },
    ])
  }
  if (command === 'exit') return
  if (['help', '--help', '-h'].includes(command)) { console.log(help(await serverVersion())); return }
  if (command === '--version') { console.log(await serverVersion()); return }
  const options = parseOptions(rest), input = await instanceEnvironment()
  let config = configuration(root, input)
  if (command === 'update') {
    const result = await componentUpdate(config, options)
    console.log(JSON.stringify(result, null, options.json ? 0 : 2)); return
  }
  if (command === 'product-update') {
    const result = await componentUpdate(config, options, (action, request = {}) => runtime(['product-updates', action, JSON.stringify(request)], config.input), 'products')
    console.log(JSON.stringify(result, null, options.json ? 0 : 2)); return
  }
  if (command === 'application-update') {
    const { updateAction } = await import('./updates.mjs')
    const action = options.rest[0] || 'status'
    if (options.rest.length > 1 && action !== 'daily') throw new Error('Choose one update operation.')
    let result
    if (action === 'daily') {
      if (options.rest.length !== 2 || !['on', 'off'].includes(options.rest[1])) throw new Error('Use update daily on or update daily off.')
      result = await updateAction(config, 'settings', { daily: options.rest[1] === 'on' })
    } else if (action === 'install') {
      const plan = await updateAction(config, 'plan')
      console.log(JSON.stringify(plan, null, 2))
      let acceptedLicenses = options.acceptedLicenses
      if (!options.yes && plan.licenses.some(license => !acceptedLicenses.includes(license.sha256))) {
        if (!await confirm('Accept the displayed product licenses and shared tool changes?')) throw new Error('Update cancelled.')
        acceptedLicenses = plan.licenses.map(license => license.sha256)
      }
      if (!options.yes && (await question('Install this update and restart the affected workspace? [y/N] ')).toLowerCase() !== 'y') throw new Error('Update cancelled.')
      result = await updateAction(config, action, { confirmed: true, revision: plan.revision, acceptedLicenses })
    } else result = await updateAction(config, action)
    console.log(JSON.stringify(result, null, options.json ? 0 : 2)); return
  }
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
    return runtime(['exec', 'uc', 'logs', config.serviceNames[['carrier', 'runner', 'server'].indexOf(name)], ...options.rest], input, false)
  }
  if (options.rest.length) throw new Error('Unknown arguments: ' + options.rest.join(' '))
  let result
  if (command === 'setup' || command === 'repair') {
    config = await chooseInstallation(config, options)
    if (command === 'repair') {
      options.repair = true
      if ((await status(config)).services.some(item => ['running', 'starting', 'stopping'].includes(item.state))) {
        if (!options.yes && !await confirm('Stop this workspace’s running work before repairing its tools?')) throw new Error('Repair cancelled.')
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
    config = await chooseInstallation(config, options)
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
