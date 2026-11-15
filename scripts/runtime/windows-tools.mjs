import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { cliDirectory as defaultCliDirectory, toolStore, inside, pythonPath, addUserPath } from './platform.mjs'
import { inspectSystem } from './setup.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
async function json(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await rename(temporary, path)
}

export async function installWindowsTools(root, input, selected) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json')))
  // Keep native Python extension paths below Windows' DLL loader path limit.
  // The receipt retains the full checksum and rejects abbreviated-name collisions.
  const store = toolStore(input), prefix = join(store, 'versions', manifest.build.slice(0, 16))
  const cliDirectory = selected.cliDirectory || defaultCliDirectory(input)
  if (inside(cliDirectory, root)) throw new Error('Choose a CLI directory outside the Aixand application installation.')
  await mkdir(join(store, 'versions'), { recursive: true })
  const lock = join(store, 'install.lock')
  try { await mkdir(lock) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner
    try {
      owner = Number(await readFile(join(lock, 'pid'), 'utf8'))
      if (owner > 0) process.kill(owner, 0)
    } catch (failure) {
      if (failure.code === 'ESRCH') {
        await rm(lock, { recursive: true })
        return installWindowsTools(root, input, selected)
      }
    }
    throw new Error('Another tool installation is in progress. Finish it before retrying.')
  }
  await writeFile(join(lock, 'pid'), String(process.pid))
  const staging = join(store, 'versions', `.install-${randomUUID()}`)
  try {
    if (existsSync(join(prefix, 'toolset.json'))) {
      const receipt = JSON.parse(await readFile(join(prefix, 'toolset.json')))
      if (receipt.build !== manifest.build || receipt.prefix !== prefix)
        throw new Error(`A different toolset already occupies ${prefix}. Move it aside before retrying.`)
    }
    if (!existsSync(join(prefix, 'toolset.json'))) {
      if (existsSync(prefix)) throw new Error(`An incomplete tool installation exists at ${prefix}. Move it aside before retrying.`)
      await mkdir(staging)
      for (const name of ['bin', 'python', 'node', 'notices', 'git', ...(manifest.features.voice ? ['voice'] : [])])
        await cp(join(root, name), join(staging, name), { recursive: true, verbatimSymlinks: true })
      await cp(join(root, 'python-entry.py'), join(staging, 'console.py'))
      const descriptor = JSON.parse(await readFile(join(root, 'bin/commands.independent.json')))
      await json(join(staging, 'bin/commands.json'), descriptor)
      await json(join(staging, 'toolset.json'), { schema: 1, build: manifest.build, prefix, distributions: manifest.distributions })
      await rename(staging, prefix)
    }
    const template = JSON.parse(await readFile(join(prefix, 'bin/commands.independent.json')))
    const launcher = await readFile(join(prefix, 'bin/aixand-command.exe'))
    const launcherHash = hash(launcher)
    await mkdir(cliDirectory, { recursive: true })
    const retained = []
    for (const [name, command] of Object.entries(template.commands)) {
      const executable = join(cliDirectory, `${name}.exe`)
      const sidecar = join(cliDirectory, `${name}.aixand-command.json`)
      let existing
      try { existing = await lstat(executable) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (existing) {
        let managed = false
        try {
          const previous = JSON.parse(await readFile(sidecar))
          managed = previous.schema === 'aixand.command/1' && inside(previous.root, join(store, 'versions')) &&
            hash(await readFile(executable)) === previous.launcherHash
        } catch {}
        if (!managed) { retained.push(executable); continue }
      } else if (existsSync(sidecar)) { retained.push(executable); continue }
      await json(sidecar, { schema: 'aixand.command/1', root: prefix, launcherHash, commands: { [name]: command } })
      const temporary = `${executable}.${randomUUID()}.tmp`
      await writeFile(temporary, launcher, { flag: 'wx' })
      await rename(temporary, executable)
    }
    await json(join(store, 'current.json'), { schema: 1, prefix })
    const pathRegistered = input.AIXAND_SKIP_PATH_REGISTRATION === '1' ? false : await addUserPath(cliDirectory, input)
    const report = await inspectSystem(root, input, { ...selected, python: pythonPath(join(prefix, 'python')),
      voicePython: manifest.features.voice ? pythonPath(join(prefix, 'voice/python')) : undefined })
    return { ...report, installed: true, prefix, retained, pathRegistered }
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}
