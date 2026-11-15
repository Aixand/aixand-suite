// Suite registers a generic UC connection; UC itself has no Suite dependency.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const execute = promisify(execFile)
const markerPath = base => join(base, 'config/uc-cli-connection.json')

export function ucConnectionStatus(base) {
  const path = markerPath(base)
  if (!existsSync(path)) return null
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const known = value.profile === 'aixand-suite' && value.owner === 'aixand-suite' ||
    value.profile === 'aixand-server-' + createHash('sha256').update(base).digest('hex').slice(0, 12) && value.owner === 'aixand-server'
  if (value.schema !== 1 || !known || value.home !== join(base, 'uc'))
    throw new Error('Invalid saved Undercurrent connection setup. Preserve the workspace configuration and repair this registration.')
  return value
}

export async function registerUcConnection(program, input, base, role = 'desktop', verification = role === 'server' ? 'configuration' : 'live-daemon') {
  if (!['configuration', 'live-daemon'].includes(verification)) throw new Error('Invalid Undercurrent connection verification mode.')
  const previous = ucConnectionStatus(base)
  const profile = previous?.profile || (role === 'server' ? 'aixand-server-' + createHash('sha256').update(base).digest('hex').slice(0, 12) : 'aixand-suite')
  const owner = previous?.owner || (role === 'server' ? 'aixand-server' : 'aixand-suite')
  const env = { ...process.env, ...input }
  // Suite's explicit instance home must not mask the saved CLI selection.
  for (const name of ['UNDERCURRENT_HOME', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete env[name]
  const run = async args => {
    try {
      const result = await execute(program, ['--json', ...args], {
        env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      })
      return JSON.parse(result.stdout)
    } catch (cause) {
      const detail = cause.stderr?.trim()
      throw new Error('Could not configure the Undercurrent CLI connection. Retry setup.' + (detail ? ' ' + detail.slice(-2000) : ''), { cause })
    }
  }
  const registered = await run(['settings', 'profiles', 'register', profile,
    '--home', join(base, 'uc'), '--owner', owner, '--auto-start', 'never',
    ...(!previous && role !== 'server' ? ['--select-if-new'] : [])])
  // Onboarding verifies a live daemon. Server setup and update repair can
  // register the exact connection while services are stopped, before restart.
  if (verification === 'configuration') {
    const listing = await run(['settings', 'profiles', 'list'])
    const saved = listing.profiles?.[profile]
    if (saved?.home !== join(base, 'uc') || saved?.owner !== owner)
      throw new Error('The saved Undercurrent connection does not match this workspace.')
  } else await run(['--connection', profile, 'daemon', 'status'])
  const report = { schema: 1, profile, owner, home: join(base, 'uc'),
    activeProfile: registered.active_profile, autoStart: 'never', verified: true,
    verification }
  const path = markerPath(base), temporary = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
  return report
}

export async function removeUcConnection(program, input, base) {
  const connection = ucConnectionStatus(base)
  if (!connection) return { removed: false }
  const { profile, owner } = connection
  if (!program || !existsSync(program)) throw new Error('Restore Undercurrent before removing its Suite connection registration.')
  const env = { ...process.env, ...input }
  for (const name of ['UNDERCURRENT_HOME', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete env[name]
  const run = async args => JSON.parse((await execute(program, ['--json', 'settings', 'profiles', ...args],
    { env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout)
  const listing = await run(['list'])
  const value = listing.profiles?.[profile]
  if (!value) return { removed: false }
  if (value.owner !== owner || value.home !== join(base, 'uc'))
    throw new Error('The ' + profile + ' CLI profile belongs to another workspace. Keep it or repair the registration before reset.')
  await run(['remove', profile])
  return { removed: true }
}
