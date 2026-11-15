// Debian resource copying materializes symlinks. Restore the build's link map
// after unpacking so Node/npm and other relocatable distributions retain it.
import { lstat, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const root = resolve(process.argv[2])
const links = JSON.parse(await readFile(join(root, 'symlinks.json'), 'utf8'))
for (const [name, target] of Object.entries(links)) {
  const path = resolve(root, name), destination = resolve(dirname(path), target)
  if (isAbsolute(name) || isAbsolute(target) || !path.startsWith(root + '/') || !destination.startsWith(root + '/'))
    throw new Error('Invalid runtime symlink: ' + name)
  const existing = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (existing?.isSymbolicLink() && await readlink(path) === target) continue
  if (existing?.isDirectory()) throw new Error('Unexpected directory at runtime link: ' + name)
  if (existing) await unlink(path)
  await symlink(target, path)
}
