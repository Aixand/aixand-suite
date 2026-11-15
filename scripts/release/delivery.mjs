// Flatten offline signing outputs into GitHub assets and a Cloudflare registration descriptor.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, copyFile, writeFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function hash(file) {
  const digest = createHash('sha256')
  for await (const block of createReadStream(file)) digest.update(block)
  return digest.digest('hex')
}
export async function prepareDelivery(directory, output, tag, origin = 'https://downloads.aixand.org') {
  if (!/^(?:suite|server|client|web|connect|vox|desktop|runner|orchestration-mcp)\/v[0-9A-Za-z.-]+$/.test(tag)) throw new Error('Choose a release tag for signed updates.')
  if (new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Use an HTTPS origin without a trailing slash.')
  const root = resolve(directory), objects = [], feeds = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) { await visit(file); continue }
      if (!entry.isFile()) throw new Error('Signing outputs must contain regular files.')
      const path = '/' + relative(root, file).split('\\').join('/')
      if (!/^\/(?:aixand-suite-components|aixand-suite-products|aixand-desktop|aixand-client|aixand-server)\//.test(path)) throw new Error('Unexpected signing output path.')
      if (entry.name === 'latest.candidate.json') {
        const envelope = JSON.parse(await readFile(file, 'utf8'))
        feeds.push({ path: path.replace(/latest\.candidate\.json$/, 'latest.json'), envelope })
      } else {
        const sha256 = await hash(file), size = (await stat(file)).size
        objects.push({ path, asset: sha256 + '-' + basename(file), sha256, size, file })
      }
    }
  }
  await visit(root)
  if (!feeds.length || !objects.length) throw new Error('Supply signed candidate feeds and immutable payloads.')
  await mkdir(resolve(output), { recursive: false })
  const copied = new Set()
  for (const object of objects) {
    if (!copied.has(object.asset)) await copyFile(object.file, join(output, object.asset))
    copied.add(object.asset)
  }
  const descriptor = { schema: 1, repository: 'Aixand/aixand-suite', tag, origin,
    feeds, objects: objects.map(({ file, ...object }) => object) }
  await writeFile(join(output, 'delivery.json'), JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx' })
  const files = (await readdir(output)).filter(name => name !== 'SHA256SUMS').sort()
  await writeFile(join(output, 'SHA256SUMS'), (await Promise.all(files.map(async name => `${await hash(join(output, name))}  ${name}\n`))).join(''))
  return descriptor
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: node scripts/release/delivery.mjs SIGNED_DIRECTORY OUTPUT TAG')
    const result = await prepareDelivery(process.argv[2], process.argv[3], process.argv[4])
    console.log(JSON.stringify({ tag: result.tag, feeds: result.feeds.length, objects: result.objects.length, publication: 'not-published' }))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
