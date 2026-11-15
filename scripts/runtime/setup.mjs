// Local tool selection and a user-level, independently usable tool installation.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { windows, binary, pythonPath, pythonSite, toolStore, cliDirectory as defaultCliDirectory, inside } from './platform.mjs'

const execute = promisify(execFile)
export const pythonCommands = ['agent', 'agent-manager-mcp', 'mcp-manager', 'prompt-manager',
  'skill-manager', 'conversation-manager', 'orchestration-mcp', 'aixand-connect', 'carrier']
export const modules = ['agent_manager', 'mcp_manager', 'prompt_manager', 'skill_manager',
  'conversation_manager', 'orchestration_mcp', 'aixand_filesystem', 'aixand_local_runtime', 'github_source', 'undercurrent', 'carrier',
  'aixand', 'runner_client', 'aixand_connect']
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export function bundledTools(root) {
  return { uc: join(root, 'bin', binary('uc')), runner: join(root, 'bin', binary('runner')),
    python: pythonPath(join(root, 'python')), pythonHome: join(root, 'python'),
    pythonExecutable: pythonPath(join(root, 'python')),
    pythonPrefix: join(root, 'python'), pythonBaseExecutable: pythonPath(join(root, 'python')),
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
    'executable': sys.executable, 'prefix': sys.prefix, 'base_executable': sys._base_executable,
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
      Object.assign(tools, { python, pythonExecutable: info.executable, pythonHome: info.home, pythonPrefix: info.prefix,
        pythonBaseExecutable: info.base_executable, pythonPaths: info.paths })
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
