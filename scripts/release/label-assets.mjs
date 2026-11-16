// Improve published asset display labels without changing filenames or download URLs.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deliveryAssetName } from './delivery.mjs'

export function assetLabel(name, paths = new Map()) {
  if (paths.has(name)) return deliveryAssetName(paths.get(name))
  const descriptions = {
    'TESTING.json': 'Testing report — platforms, coverage and signing limitations',
    'delivery.json': 'Update delivery map — signed feeds and download locations',
    'composition.json': 'Release inventory — components, source revision and checksums',
    'SHA256SUMS': 'SHA256SUMS — download verification checksums',
  }
  if (descriptions[name]) return descriptions[name]
  if (name.endsWith('-application.json')) return 'Installer metadata — ' + name
  if (name.endsWith('-qualification.json')) return 'Installer test evidence — ' + name
  return name
}

function api(endpoint, ...args) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
}
export function uploadArguments(directory) {
  const root = resolve(directory), files = readdirSync(root).sort(), paths = new Map()
  if (files.includes('delivery.json')) {
    for (const object of JSON.parse(readFileSync(join(root, 'delivery.json'), 'utf8')).objects) paths.set(object.asset, object.path)
  }
  return files.map(name => `${join(root, name)}#${assetLabel(name, paths)}`)
}

export function labelRelease(tag, apply = false) {
  const repository = 'Aixand/aixand-suite'
  const release = api(`repos/${repository}/releases/tags/${encodeURIComponent(tag)}`)
  const descriptor = release.assets.find(asset => asset.name === 'delivery.json')
  const paths = new Map()
  if (descriptor) {
    const delivery = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/assets/${descriptor.id}`, '-H', 'Accept: application/octet-stream'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
    for (const object of delivery.objects) paths.set(object.asset, object.path)
  }
  const changes = []
  for (const asset of release.assets) {
    const label = assetLabel(asset.name, paths)
    if (asset.label === label) continue
    if (apply) {
      const updated = api(`repos/${repository}/releases/assets/${asset.id}`, '--method', 'PATCH', '-f', `label=${label}`)
      for (const key of ['id', 'name', 'size', 'digest', 'browser_download_url']) {
        if (updated[key] !== asset[key]) throw new Error('Asset identity changed: ' + key)
      }
      if (updated.label !== label) throw new Error('Asset label was not saved.')
    }
    changes.push({ name: asset.name, label })
  }
  return { tag, applied: apply, changes }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, option] = process.argv.slice(2)
    if (tag === '--upload-arguments' && option && process.argv.length === 4) {
      console.log(JSON.stringify(uploadArguments(option)))
    } else {
      if (!tag || (option && option !== '--apply') || process.argv.length > 4) throw new Error('Usage: node scripts/release/label-assets.mjs COMPONENT/vVERSION [--apply]')
      console.log(JSON.stringify(labelRelease(tag, option === '--apply'), null, 2))
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
