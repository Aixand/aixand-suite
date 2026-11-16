// Component helpers run outside the service lifecycle they are allowed to stop.
import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { componentUpdateAction } from './component-updates.mjs'
import { atomicJson } from './updates.mjs'

const execute = promisify(execFile)
export function componentWorkerEnvironment(config) {
  const allowed = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'PATH', 'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'USER', 'LOGNAME', 'AIXAND_SHARED_PRODUCT_PREFIX',
    'AIXAND_SKIP_PATH_REGISTRATION', 'NODE_EXTRA_CA_CERTS', 'TMPDIR', 'TMP', 'TEMP',
    'AIXAND_LOCAL_PORT', 'AIXAND_LOCAL_CARRIER_PORT']
  const env = Object.fromEntries(allowed.filter(key => config.input?.[key] !== undefined).map(key => [key, config.input[key]]))
  for (const key of ['AIXAND_PRODUCTION_ORIGINS', 'AIXAND_PRODUCTION_TRANSPORT', 'AIXAND_PRODUCTION_TRUST_PROXY'])
    if (config.env?.[key]) env[key] = config.env[key]
  return { ...env, AIXAND_LOCAL_HOME: config.base, NODE_OPTIONS: '', NODE_PATH: '' }
}
export function windowsComponentLaunch({ config, job, operation, worker }) {
  if (!/^[a-f0-9-]{36}$/.test(operation)) throw new Error('Invalid component operation identity.')
  const env = componentWorkerEnvironment(config)
  const program = join(env.SystemRoot || env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const taskName = 'AixandComponentUpdate-' + operation
  const payload = Buffer.from(JSON.stringify({ node: process.execPath, worker, job, env })).toString('base64')
  const launch = `$ErrorActionPreference='Stop'\n$job=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n$job.env.PSObject.Properties | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name,[string]$_.Value,'Process') }\n& $job.node $job.worker $job.job --outside-lifecycle\nexit $LASTEXITCODE\n`
  const argumentsText = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64')
  const data = Buffer.from(JSON.stringify({ name: taskName, program, args: argumentsText })).toString('base64')
  const script = `$ErrorActionPreference='Stop'\n$job=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n$token=[Security.Principal.WindowsIdentity]::GetCurrent()\n$level=if((New-Object Security.Principal.WindowsPrincipal($token)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'Highest'}else{'Limited'}\n$principal=New-ScheduledTaskPrincipal -UserId $token.Name -LogonType Interactive -RunLevel $level\n$action=New-ScheduledTaskAction -Execute $job.program -Argument $job.args\n$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\nRegister-ScheduledTask -TaskName $job.name -Action $action -Principal $principal -Settings $settings | Out-Null\nStart-ScheduledTask -TaskName $job.name\n`
  return { program, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], taskName, env }
}
export async function launchComponentWorker(input) {
  const { config, job, worker } = input
  const env = componentWorkerEnvironment(config)
  if (process.platform !== 'win32') {
    const child = spawn(process.execPath, [worker, job, '--outside-lifecycle'], { env, detached: true, stdio: 'ignore' })
    await new Promise((ready, fail) => { child.once('spawn', ready); child.once('error', fail) })
    child.unref()
    return { pid: child.pid, outsideLifecycle: true }
  }
  const launch = windowsComponentLaunch(input)
  const descriptor = JSON.parse(await readFile(job, 'utf8'))
  await atomicJson(job, { ...descriptor, taskName: launch.taskName })
  await execute(launch.program, launch.args, { env: launch.env, windowsHide: true, timeout: 30000 })
  for (let attempt = 0; attempt < 100; attempt++) {
    let lease
    try { lease = JSON.parse(await readFile(join(dirname(job), 'lease.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (lease?.operation === input.operation && Number.isInteger(lease.pid) && lease.pid > 0) {
      process.kill(lease.pid, 0)
      return { pid: lease.pid, outsideLifecycle: true }
    }
    await delay(100)
  }
  throw new Error('The external component helper did not start. Inspect its recovery journal.')
}
export async function componentAction(config, action, input = {}, dependencies = {}) {
  const result = await componentUpdateAction(config, action, input, { launchWorker: launchComponentWorker, ...dependencies })
  return { ...result, mode: 'components' }
}
