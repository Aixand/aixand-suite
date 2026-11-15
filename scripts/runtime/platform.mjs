import { spawn, execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative, isAbsolute, delimiter } from 'node:path'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'

export const windows = process.platform === 'win32'
export const binary = name => windows ? `${name}.exe` : name
export const pythonPath = root => join(root, windows ? 'python.exe' : 'bin/python3')
export const nodePath = root => join(root, windows ? 'node/node.exe' : 'node/bin/node')
export const pythonSite = root => join(root, windows ? 'Lib/site-packages' : 'lib/python3.12/site-packages')
export const toolStore = input => windows ? join(input.LOCALAPPDATA || join(input.HOME, 'AppData/Local'), 'AixandTools') : join(input.HOME, '.local/share/aixand-tools')
export const cliDirectory = input => windows ? join(toolStore(input), 'bin') : join(input.HOME, '.local/bin')
export const inside = (path, directory) => {
  const value = relative(directory, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

export function localConnection(path) {
  if (!windows) return createConnection(path)
  const bytes = readFileSync(path)
  if (bytes.length > 4096) throw new Error('Invalid local endpoint.')
  const value = JSON.parse(bytes)
  if (value.schema !== 'aixand.local/1' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token))
    throw new Error('Invalid local endpoint.')
  const socket = createConnection({ host: '127.0.0.1', port: value.port })
  socket.once('connect', () => socket.write(JSON.stringify({ token: value.token }) + '\n'))
  return socket
}

export function replaceProcess(program, args, env) {
  if (!windows) return process.execve(program, [program, ...args], env)
  // Windows has no execve. Keep the supervisor attached to its UC job and share
  // its console; native children receive console shutdown events directly.
  const child = spawn(program, args, { env, stdio: 'inherit', windowsHide: true })
  process.on('SIGBREAK', () => {})
  process.on('SIGINT', () => {})
  child.once('error', error => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}

export async function addUserPath(directory, input) {
  return updateUserPath(directory, input, false)
}

export async function removeUserPath(directory, input) {
  return updateUserPath(directory, input, true)
}

async function updateUserPath(directory, input, removing) {
  if (!windows) return false
  const script = `$ErrorActionPreference='Stop'
$directory=$env:AIXAND_CLI_DIRECTORY
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $value=[string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind=if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $entries=@($value -split ';' | Where-Object { $_ })
  if ($env:AIXAND_CLI_REMOVE -eq '1') {
    $kept=@($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ine $directory.TrimEnd('\\') })
    if ($kept.Count -ne $entries.Count) { $key.SetValue('Path',($kept -join ';'),$kind) }
  } elseif (-not ($entries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $directory.TrimEnd('\\') })) {
    $key.SetValue('Path',(($entries + $directory) -join ';'),$kind)
  }
} finally { $key.Dispose() }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AixandEnvironmentNotification {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string value, uint flags, uint timeout, out UIntPtr result);
}
'@
[UIntPtr]$result=[UIntPtr]::Zero
[void][AixandEnvironmentNotification]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,3000,[ref]$result)

`
  await promisify(execFile)(join(input.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...input, AIXAND_CLI_DIRECTORY: directory, AIXAND_CLI_REMOVE: removing ? '1' : '0' }, windowsHide: true, timeout: 20_000 })
  return true
}
