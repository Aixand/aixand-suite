// Optional, per-user login startup. Never installs a root/SYSTEM service.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { nodePath } from './platform.mjs'

const execute = promisify(execFile)
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const unitArgument = value => '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'

export function startupPlan(config, platform = process.platform) {
  const id = createHash('sha256').update(config.base).digest('hex').slice(0, 16)
  const name = 'org.aixand.server.' + id
  const program = nodePath(config.root), script = join(config.root, 'server-cli.mjs')
  if ([program, script, config.base].some(value => /[\r\n\0]/.test(value))) throw new Error('Startup paths cannot contain control characters.')
  const owner = 'Aixand Server workspace: ' + config.base
  if (platform === 'linux') {
    const file = join(config.env.HOME, '.config/systemd/user', name + '.service')
    const content = `[Unit]\nDescription=${owner.replaceAll('%', '%%')}\n\n[Service]\nType=simple\nExecStart=${[program, script, 'run'].map(unitArgument).join(' ')}\nRestart=on-failure\nTimeoutStopSec=90\n\n[Install]\nWantedBy=default.target\n`
    return { name, file, content, owner, platform, program, script }
  }
  if (platform === 'darwin') {
    const file = join(config.env.HOME, 'Library/LaunchAgents', name + '.plist')
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[program, script, 'run'].map(value => '<string>' + xml(value) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(config.env.HOME)}</string></dict></dict></plist>\n`
    return { name, file, content, owner, platform, program, script }
  }
  if (platform === 'win32') {
    const taskProgram = join(config.input.SystemRoot || config.input.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const payload = Buffer.from(JSON.stringify({ program, script })).toString('base64')
    const launch = `$task=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n& $task.program $task.script run\nexit $LASTEXITCODE\n`
    const taskArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64')
    return { name, owner, platform, program, script, taskProgram, taskArguments }
  }
  throw new Error('User-login startup is unsupported on this platform.')
}

export async function startup(config, action) {
  if (!['status', 'enable', 'disable'].includes(action)) throw new Error('Use startup status, enable or disable.')
  const plan = startupPlan(config)
  if (plan.platform === 'win32') {
    const data = Buffer.from(JSON.stringify({ ...plan, action })).toString('base64')
    const script = `$ErrorActionPreference='Stop'
$plan=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$task=Get-ScheduledTask -TaskName $plan.name -ErrorAction SilentlyContinue
if ($task -and ($task.Description -ne $plan.owner -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $plan.taskProgram -or $task.Actions[0].Arguments -ne $plan.taskArguments)) { throw 'The startup task belongs to another installation.' }
if ($plan.action -eq 'enable') {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Priority 6
  $launch=New-ScheduledTaskAction -Execute $plan.taskProgram -Argument $plan.taskArguments
  Register-ScheduledTask -TaskName $plan.name -Description $plan.owner -Principal $principal -Trigger $trigger -Action $launch -Settings $settings -Force | Out-Null
} elseif ($plan.action -eq 'disable' -and $task) { Unregister-ScheduledTask -TaskName $plan.name -Confirm:$false }
$enabled=($plan.action -eq 'enable') -or ($plan.action -eq 'status' -and $null -ne $task)
@{enabled=$enabled;name=$plan.name;scope='user-login'} | ConvertTo-Json -Compress
`
    return JSON.parse((await execute(join(config.input.SystemRoot || config.input.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: config.input, windowsHide: true, timeout: 30_000 })).stdout)
  }
  if (existsSync(plan.file)) {
    const current = await readFile(plan.file, 'utf8')
    if (current !== plan.content) throw new Error('The existing startup file differs from this installation. Review it before replacing it.')
  }
  if (action === 'status') return { enabled: existsSync(plan.file), scope: 'user-login', name: plan.name }
  if (action === 'enable') {
    await mkdir(dirname(plan.file), { recursive: true, mode: 0o700 }); await writeFile(plan.file, plan.content, { mode: 0o600 })
    if (plan.platform === 'linux') {
      try {
        await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 20_000 })
        await execute('systemctl', ['--user', 'enable', plan.name + '.service'], { timeout: 20_000 })
      } catch (error) { await unlink(plan.file); throw new Error('Could not enable user startup. A systemd user session is required. ' + error.message) }
    }
  } else {
    if (plan.platform === 'linux' && existsSync(plan.file)) await execute('systemctl', ['--user', 'disable', plan.name + '.service'], { timeout: 20_000 })
    if (existsSync(plan.file)) await unlink(plan.file)
    if (plan.platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 20_000 })
  }
  return { enabled: action === 'enable', scope: 'user-login', name: plan.name }
}
