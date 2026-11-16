// Flatten offline signing outputs into GitHub assets and a Cloudflare registration descriptor.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, copyFile, writeFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function hash(file) {
  const digest = createHash('sha256')
  for await (const block of createReadStream(file)) digest.update(block)
  return digest.digest('hex')
}
// GitHub filenames are presentation only; signed download paths stay unchanged.
export function deliveryAssetName(path) {
  const parts = path.replace(/^\//, '').split('/')
  const file = parts.pop().replace(/^(?:[a-f0-9]{64}|[a-f0-9]{16})-/, '')
  let name
  if (/^aixand-(?:desktop|client|server)$/.test(parts[0])) {
    const [product, revision] = parts, version = revision.replace(/\.r[0-9]+$/, '')
    if (['SHA256SUMS', 'manifest.json', 'release.json'].includes(file)) {
      name = `${product}-${version}-${file}`
    } else {
      const platform = /\.deb$|linux/i.test(file) ? 'linux-x64' : /\.dmg$|\.app\.tar\.gz$|macos/i.test(file) ? 'macos-arm64' : /\.exe$/i.test(file) ? 'windows-x64' : null
      if (!platform) throw new Error('Unknown native delivery filename: ' + file)
      const suffix = file.endsWith('.app.tar.gz') ? '-update.app.tar.gz' : file.endsWith('.deb') ? '.deb' : file.endsWith('.dmg') ? '.dmg' : file.endsWith('.exe') ? '-setup.exe' : '-setup'
      name = `${product}-${version}-${platform}${suffix}`
    }
  } else if (parts[0] === 'aixand-suite-products') {
    const [, target, ...identity] = parts
    const version = identity.pop(), product = identity.join('-')
    const suffix = file.endsWith('.tar.gz') ? '.tar.gz' : file.endsWith('.zip') ? '.zip' : null
    if (!suffix) throw new Error('Unknown product delivery filename: ' + file)
    name = `aixand-${product}-${version}-${target}-update${suffix}`
  } else {
    name = [...parts.slice(1), file].join('-')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,239}$/.test(name)) throw new Error('Unsafe delivery asset name.')
  return name
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
        objects.push({ path, asset: deliveryAssetName(path), sha256, size, file })
      }
    }
  }
  await visit(root)
  if (!feeds.length || !objects.length) throw new Error('Supply signed candidate feeds and immutable payloads.')
  const names = new Map()
  for (const object of objects) {
    const name = object.asset.toLowerCase(), previous = names.get(name)
    if (previous && (previous.sha256 !== object.sha256 || previous.asset !== object.asset)) throw new Error('Delivery filename collision: ' + object.asset)
    names.set(name, object)
  }
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
