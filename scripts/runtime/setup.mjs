// Local tool selection and a user-level, independently usable tool installation.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { windows, binary, pythonPath, pythonSite, toolStore, cliDirectory as defaultCliDirectory, inside } from './platform.mjs'
import { productLocation, installProducts } from './products.mjs'

const execute = promisify(execFile)
export const pythonCommands = ['agent', 'agent-manager-mcp', 'mcp-manager', 'prompt-manager',
  'skill-manager', 'server-manager', 'orchestration-mcp', 'aixand-connect', 'aixand-mcp', 'carrier']
export const modules = ['agent_manager', 'mcp_manager', 'prompt_manager', 'skill_manager',
  'server_manager', 'orchestration_mcp', 'resource_sources', 'undercurrent', 'carrier',
  'aixand', 'runner_client', 'aixand_connect', 'aixand_mcp']
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export function bundledTools(root) {
  return { uc: join(root, 'bin', binary('uc')), runner: join(root, 'bin', binary('runner')),
    python: pythonPath(join(root, 'python')), pythonHome: join(root, 'python'),
    pythonPaths: [pythonSite(join(root, 'python'))],
    voicePython: pythonPath(join(root, 'voice/python')),
    bridge: join(root, 'bin', binary('uc-python-bridge')), binDirectory: join(root, 'bin') }
}

export function options(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local setup options.')
  const mode = value.mode || 'bundled'
  if (!['bundled', 'system'].includes(mode)) throw new Error('Choose Self-contained or Use system tools.')
  if (value.reuseConfig !== undefined && typeof value.reuseConfig !== 'boolean') throw new Error('Configuration reuse must be explicitly enabled or disabled.')
  const result = { mode, reuseConfig: Boolean(value.reuseConfig) }
  if (mode === 'bundled' && result.reuseConfig) throw new Error('Existing manager configuration is only available with system tools.')
  for (const key of ['binDirectory', 'python', 'voicePython', 'cliDirectory']) {
    if (value[key]) {
      if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || value[key].includes('\0'))
        throw new Error(`${key} must be an absolute path.`)
      result[key] = resolve(value[key])
    }
  }
  return result
}

export function readSelection(base) {
  const path = join(base, 'config/setup.json')
  if (!existsSync(path)) return { configured: false, mode: 'bundled', reuseConfig: false }
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved.schema !== 1) throw new Error('Unsupported local setup format. Run aixand-runtime setup save with a supported mode.')
  return { ...saved, ...options(saved.options || saved), configured: true }
}

export async function saveSelection(base, selected, tools, managerEnvironment = {}) {
  const directory = join(base, 'config')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `setup-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify({ schema: 1, options: options(selected), tools, managerEnvironment }, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, join(directory, 'setup.json'))
}

async function output(program, args, env, timeout = 20_000) {
  return (await execute(program, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}
function cleanEnvironment(input) {
  const env = { ...input, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  return env
}
async function executable(path, root) {
  try {
    await access(path, constants.X_OK)
    if (inside(realpathSync(path), root)) return false
    // The optional bundled CLI package is not an independent system toolset.
    if (!windows && readFileSync(path).subarray(0, 400).toString().includes("import('/usr/lib/Aixand/runtime/runtime.mjs')")) return false
    return true
  } catch { return false }
}
function installedPrefix(input) {
  try { return JSON.parse(readFileSync(join(toolStore(input), 'current.json'), 'utf8')).prefix }
  catch { return undefined }
}
async function candidates(name, directories, root) {
  const found = []
  for (const directory of [...new Set(directories.filter(Boolean))]) {
    const path = join(directory, binary(name))
    if (await executable(path, root)) found.push(path)
  }
  return found
}
function shebangPython(command) {
  try {
    const line = readFileSync(command, 'utf8').split('\n')[0]
    const value = line.match(/^#!(\/[^\s]+python(?:3(?:\.12)?)?)\s*$/)?.[1]
    return value
  } catch { return undefined }
}
const pythonProbe = `import importlib, importlib.metadata as m, json, site, sys
errors = []
for name in ${JSON.stringify(modules)}:
    try: importlib.import_module(name)
    except Exception as error: errors.append(name + ': ' + str(error))
print(json.dumps({'version': list(sys.version_info[:2]), 'home': sys.base_prefix,
    'paths': site.getsitepackages(), 'packages': {d.metadata['Name'].lower().replace('_','-'): d.version for d in m.distributions()}, 'errors': errors}))`

export async function inspectSystem(root, input, rawOptions = {}) {
  const selected = options({ ...rawOptions, mode: 'system' })
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const prefix = installedPrefix(input)
  const directories = [selected.binDirectory, ...(input.PATH || '').split(delimiter),
    defaultCliDirectory(input), prefix && join(prefix, 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
    .filter(path => path && isAbsolute(path) && !inside(resolve(path), root))
  const env = cleanEnvironment({ ...input, PATH: directories.join(delimiter) })
  const checks = [], tools = {}, commands = {}
  for (const name of ['uc', 'runner']) {
    const expected = await output(join(root, 'bin', binary(name)), ['--version'], env)
    let failure = `Not found. Expected ${expected}.`
    for (const path of await candidates(name, directories, root)) {
      try {
        const version = await output(path, ['--version'], env)
        if (version !== expected) { failure = `${path}: ${version}; expected ${expected}.`; continue }
        tools[name] = realpathSync(path)
        break
      } catch (error) { failure = `${path}: ${error.message}` }
    }
    checks.push({ name, ready: Boolean(tools[name]), path: tools[name], message: tools[name] ? expected : failure })
  }
  if (tools.uc) {
    const sibling = join(dirname(realpathSync(tools.uc)), binary('uc-python-bridge'))
    tools.bridge = await executable(sibling, root) ? sibling : (await candidates('uc-python-bridge', directories, root))[0]
  }
  checks.push({ name: 'Undercurrent Python bridge', ready: Boolean(tools.bridge), path: tools.bridge,
    message: tools.bridge ? 'Available' : 'Install uc-python-bridge alongside Undercurrent.' })
  const agents = await candidates('agent', directories, root)
  const pythons = selected.python ? [selected.python] : [...new Set([...agents.map(shebangPython), prefix && pythonPath(join(prefix, 'python')),
    ...await candidates('python3.12', directories, root), ...await candidates('python3', directories, root), ...await candidates('python', directories, root)].filter(Boolean))]
  let pythonError = 'No compatible Python environment found.'
  for (const python of pythons) {
    if (!await executable(python, root)) continue
    try {
      const info = JSON.parse(await output(python, ['-B', '-c', pythonProbe], env, 40_000))
      const errors = [...info.errors]
      if (info.version.join('.') !== '3.12') errors.unshift('Python 3.12 is required by the native workflow bridge.')
      for (const [name, version] of Object.entries(manifest.distributions)) {
        if (name === 'aixand-vox') continue
        if (info.packages[name.toLowerCase().replaceAll('_', '-')] !== version) errors.push(`${name}==${version} is required.`)
      }
      if (errors.length) { pythonError = `${python}: ${errors.slice(0, 8).join(' ')}`; continue }
      Object.assign(tools, { python, pythonHome: info.home, pythonPaths: info.paths })
      break
    } catch (error) { pythonError = `${python}: ${error.stderr?.trim() || error.message}` }
  }
  checks.push({ name: 'Manager Suite and SDK Python environment', ready: Boolean(tools.python), path: tools.python,
    message: tools.python ? 'Python 3.12 and all required Aixand packages are compatible.' : pythonError })
  const commandDirectories = [tools.python && dirname(tools.python),
    prefix && tools.python === pythonPath(join(prefix, 'python')) ? join(prefix, 'bin') : undefined, tools.python && windows ? join(dirname(tools.python), 'Scripts') : undefined, ...directories]
  for (const name of pythonCommands) {
    commands[name] = (await candidates(name, commandDirectories, root))[0]
    checks.push({ name, ready: Boolean(commands[name]), path: commands[name], message: commands[name] ? 'Installed' : 'CLI entry point not found.' })
  }
  for (const name of ['codex', 'claude']) commands[name] = (await candidates(name, directories, root))[0]
  if (manifest.features.voice) {
    let voiceError = 'A separate compatible voice environment is required.'
    const voice = (await candidates('aixand-vox', directories, root))[0]
    const choices = [...new Set([selected.voicePython, voice && shebangPython(voice),
      prefix && pythonPath(join(prefix, 'voice/python')), tools.python].filter(Boolean))]
    for (const python of choices) {
      if (!await executable(python, root)) continue
      try {
        const version = await output(python, ['-B', '-c', 'import aixand_vox.speech,sherpa_onnx,importlib.metadata; print(importlib.metadata.version("aixand-vox"))'], env, 60_000)
        if (version !== manifest.distributions['aixand-vox']) continue
        tools.voicePython = python; break
      } catch (error) {
        voiceError = `${python}: ${(error.stderr?.trim() || error.message).split(/\r?\n/).at(-1)}`
      }
    }
    checks.push({ name: 'Voice Python environment', ready: Boolean(tools.voicePython), path: tools.voicePython,
      message: tools.voicePython ? 'Voice dependencies are available.' : voiceError })
  }
  if (tools.runner && tools.python) {
    // An invalid SDK configuration fails before opening any service/database.
    const directory = join(tmpdir(), `aixand-sdk-probe-${randomUUID()}`)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'invalid.json'), '{')
    let supported = false
    try {
      await output(tools.runner, ['--home', directory, 'serve', '--sdk-config', join(directory, 'invalid.json')],
        { ...env, PYTHONHOME: tools.pythonHome }, 5000)
    } catch (error) {
      const message = `${error.stdout || ''} ${error.stderr || ''}`
      supported = !error.killed && !message.includes('Rebuild with --features sdk') && /json|key must|EOF|parse/i.test(message)
    } finally { await rm(directory, { recursive: true, force: true }) }
    checks.push({ name: 'Runner SDK support', ready: supported, path: tools.runner,
      message: supported ? 'Enabled' : 'Runner must be built with --features sdk.' })
  }
  tools.commands = commands
  tools.binDirectory = tools.uc ? dirname(realpathSync(tools.uc)) : selected.binDirectory
  return { mode: 'system', ready: checks.every(check => check.ready), checks, tools,
    cliDirectory: selected.cliDirectory || defaultCliDirectory(input),
    installationDirectory: toolStore(input),
    pathIncludesCliDirectory: (input.PATH || '').split(delimiter).includes(selected.cliDirectory || defaultCliDirectory(input)) }
}

async function script(path, body) { await writeFile(path, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); await chmod(path, 0o755) }
async function atomicJson(path, value) {
  const temporary = path + `.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

export async function installTools(root, input, rawOptions = {}) {
  const base = input.AIXAND_LOCAL_HOME || (windows
    ? join(input.LOCALAPPDATA || join(input.HOME, 'AppData/Local'), 'Aixand/local')
    : join(input.XDG_DATA_HOME || join(input.HOME, '.local/share'), 'aixand/local'))
  if (productLocation(root, input, base)) return installProducts(root, input, base, rawOptions)
  const selected = options({ ...rawOptions, mode: 'system' })
  if (windows) return (await import('./windows-tools.mjs')).installWindowsTools(root, input, selected)
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const store = toolStore(input)
  const prefix = join(store, 'versions', manifest.build)
  const cliDirectory = selected.cliDirectory || defaultCliDirectory(input)
  if (inside(cliDirectory, root)) throw new Error('Choose a CLI directory outside the Aixand application installation.')
  await mkdir(join(store, 'versions'), { recursive: true, mode: 0o700 })
  const lock = join(store, 'install.lock')
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner
    try { owner = Number(await readFile(join(lock, 'pid'), 'utf8')); process.kill(owner, 0) }
    catch (error) {
      if (error.code === 'ESRCH') { await rm(lock, { recursive: true }); return installTools(root, input, selected) }
      if (error.code === 'ENOENT' && Date.now() - (await stat(lock)).mtimeMs > 120_000) {
        await rm(lock, { recursive: true }); return installTools(root, input, selected)
      }
    }
    throw new Error('Another tool installation is in progress. Try again after it finishes.')
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  const staging = join(store, 'versions', `.install-${randomUUID()}`)
  try {
    if (!existsSync(join(prefix, 'toolset.json'))) {
      if (existsSync(prefix)) throw new Error(`An incomplete tool installation exists at ${prefix}. Move it aside before retrying.`)
      await mkdir(join(staging, 'bin'), { recursive: true, mode: 0o700 })
      await mkdir(join(staging, 'libexec'))
      for (const name of ['python', 'node', 'notices', ...(manifest.features.voice ? ['voice'] : [])])
        await cp(join(root, name), join(staging, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
      for (const name of ['uc', 'uc-daemon', 'uc-session-host', 'uc-python-bridge', 'uv', 'uvx'])
        await cp(join(root, 'bin', name), join(staging, 'bin', name))
      for (const name of ['node', 'npm', 'npx']) await symlink(`../node/bin/${name}`, join(staging, 'bin', name))
      await cp(join(root, 'bin', binary('runner')), join(staging, 'libexec/runner'))
      await cp(join(root, 'python-entry.py'), join(staging, 'console.py'))
      await script(join(staging, 'bin/runner'), `export PYTHONHOME=${quote(join(prefix, 'python'))}\nexec ${quote(join(prefix, 'libexec/runner'))} "$@"`)
      const exposed = ['uc', 'uc-daemon', 'uc-session-host', 'uc-python-bridge', 'runner', ...pythonCommands, 'node', 'npm', 'npx', 'uv', 'uvx',
        ...(manifest.features.voice ? ['aixand-vox', 'aixand-vox-prepare'] : [])]
      for (const name of [...pythonCommands, ...(manifest.features.voice ? ['aixand-vox', 'aixand-vox-prepare'] : [])]) {
        const python = join(prefix, name.startsWith('aixand-vox') ? 'voice/python/bin/python3' : 'python/bin/python3')
        await script(join(staging, 'bin', name), `exec ${quote(python)} -B ${quote(join(prefix, 'console.py'))} ${quote(name)} "$@"`)
      }
      await atomicJson(join(staging, 'toolset.json'), { schema: 1, build: manifest.build, prefix, commands: exposed, distributions: manifest.distributions })
      await rename(staging, prefix)
    }
    const descriptor = JSON.parse(await readFile(join(prefix, 'toolset.json'), 'utf8'))
    if (descriptor.build !== manifest.build || descriptor.prefix !== prefix) throw new Error('The installed toolset metadata does not match this installation.')
    await mkdir(cliDirectory, { recursive: true })
    const retained = []
    for (const name of descriptor.commands) {
      const destination = join(cliDirectory, name)
      let existing
      try { existing = await lstat(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (existing) {
        let managed = false
        if (existing.isSymbolicLink()) {
          try { managed = inside(realpathSync(destination), join(store, 'versions')) } catch { /* Keep unknown broken links. */ }
        }
        if (!managed) { retained.push(destination); continue }
        const temporary = destination + `.${randomUUID()}.tmp`
        await symlink(join(prefix, 'bin', name), temporary)
        await rename(temporary, destination)
      } else {
        try { await symlink(join(prefix, 'bin', name), destination) }
        catch (error) { if (error.code === 'EEXIST') retained.push(destination); else throw error }
      }
    }
    await atomicJson(join(store, 'current.json'), { schema: 1, prefix })
    const report = await inspectSystem(root, input, { ...selected, python: pythonPath(join(prefix, 'python')),
      voicePython: manifest.features.voice ? pythonPath(join(prefix, 'voice/python')) : undefined })
    return { ...report, installed: true, prefix, retained }
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}
