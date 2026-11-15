// Product releases selected after installation live outside the sealed application.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'

const must = (ok, message) => { if (!ok) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export const productSelectionPath = base => join(base, 'config/product-selection.json')
export const productObjectPath = (base, id, digest) => {
  must(/^[a-z][a-z0-9-]*$/.test(id) && hex(digest), 'Invalid selected product object identity.')
  return join(resolve(base), 'software/product-updates/objects', id, digest, 'artifacts')
}

export function privateProductPath(base, path) {
  const root = resolve(base), full = resolve(path), rel = relative(root, full)
  must(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'), 'Product update path escapes workspace.')
  let current = root
  for (const part of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
    current = part ? join(current, part) : current
    if (existsSync(current)) must(!lstatSync(current).isSymbolicLink(), 'Product update path is redirected.')
  }
  if (existsSync(full) && existsSync(root)) {
    const expected = join(realpathSync(root), rel), actual = realpathSync(full)
    must(actual === expected || process.platform === 'win32' && actual.toLowerCase() === expected.toLowerCase(), 'Product update path is redirected.')
  }
  return full
}

export function readProductSelection(base) {
  const path = privateProductPath(base, productSelectionPath(base))
  if (!existsSync(path)) return { schema: 1, assemblies: {} }
  must(lstatSync(path).isFile(), 'Product selection must be a regular file.')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  must(object(value) && value.schema === 1 && object(value.assemblies)
    && Object.keys(value).sort().join() === 'assemblies,schema', 'Invalid product selection.')
  for (const [id, item] of Object.entries(value.assemblies)) {
    must(object(item) && Object.keys(item).every(key => ['manifestSha256', 'compatibleBuilds'].includes(key)) && hex(item.manifestSha256)
      && (!item.compatibleBuilds || Array.isArray(item.compatibleBuilds) && item.compatibleBuilds.length > 0
        && item.compatibleBuilds.length <= 64 && item.compatibleBuilds.every(hex)), 'Invalid selected product release.')
    productObjectPath(base, id, item.manifestSha256)
  }
  return value
}

export function selectedProductAssembly(base, original, item, target) {
  const artifact = privateProductPath(base, productObjectPath(base, original.id, item.manifestSha256))
  const file = privateProductPath(base, join(artifact, 'release-manifest.json'))
  must(existsSync(file) && lstatSync(file).isFile(), 'Selected product manifest is missing.')
  const bytes = readFileSync(file)
  must(hash(bytes) === item.manifestSha256, 'Selected product manifest changed.')
  const manifest = JSON.parse(bytes)
  must(manifest.schema === 2 && manifest.kind !== 'component' && manifest.target === target && object(manifest.products)
    && Object.keys(manifest.products).sort().join() === Object.keys(original.products).sort().join(), 'Selected product does not match its installation identity.')
  const products = {}, licenses = []
  for (const [id, product] of Object.entries(manifest.products)) {
    must(product.id === id && hex(product.release) && typeof product.version === 'string' && object(product.commands)
      && Object.keys(product.commands).sort().join() === [...original.products[id].commands].sort().join(), 'Selected product commands or identity changed.')
    products[id] = { release: product.release, version: product.version, commands: Object.keys(product.commands).sort() }
    if (product.license_acceptance) {
      const license = product.license_acceptance, entry = product.files?.[license.path]
      must(entry && /^objects\/[a-f0-9]{64}$/.test(entry.artifact) && hex(license.sha256), 'Invalid selected product license.')
      const text = readFileSync(privateProductPath(base, join(artifact, entry.artifact)), 'utf8')
      must(hash(text) === license.sha256, 'Selected product license changed.')
      licenses.push({ product: id, sha256: license.sha256, text })
    }
  }
  return { ...original, artifact, manifest_sha256: item.manifestSha256, baseline: manifest.baseline, products, licenses, independentlySelected: true }
}

export function resolveProductCatalog(base, baseline) {
  const selection = readProductSelection(base)
  must(Object.keys(selection.assemblies).every(id => baseline.assemblies.some(row => row.id === id)), 'Selected product is not included in this application.')
  for (const item of Object.values(selection.assemblies)) if (item.compatibleBuilds && baseline.runtimeBuild)
    must(item.compatibleBuilds.includes(baseline.runtimeBuild), 'Selected product is not qualified for this application build. Use a reviewed compatible update plan.')
  const assemblies = baseline.assemblies.map(row => Object.hasOwn(selection.assemblies, row.id)
    ? selectedProductAssembly(base, row, selection.assemblies[row.id], baseline.target) : row)
  return { ...baseline, assemblies, baselineDigest: baseline.digest,
    digest: Object.keys(selection.assemblies).length ? hash(JSON.stringify({ baseline: baseline.digest, selection })) : baseline.digest }
}

export const productArtifactPath = (root, row) => row.independentlySelected ? row.artifact : join(root, 'products', row.artifact)
