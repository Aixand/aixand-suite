// Improve published asset display labels without changing filenames or download URLs.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deliveryAssetName } from './delivery.mjs'

export function releaseTitle(tag) {
  const match = /^([a-z-]+)\/v([0-9A-Za-z.-]+)$/.exec(tag)
  if (!match) throw new Error('Invalid component release tag.')
  const titles = {
    suite: 'Aixand Suite — All installers', desktop: 'Aixand Suite', client: 'Aixand Client',
    server: 'Aixand Server', web: 'Aixand Client — Web assets (not an installer)',
    'python-sdk': 'Aixand Suite — Python SDK',
    'runner-client': 'Aixand Suite — Runner Python library',
    runner: 'Aixand Suite — Runner', connect: 'Aixand Suite — Connect',
    'orchestration-mcp': 'Aixand Suite — Orchestration MCP',
    ir: 'Aixand Suite — IR Rust crates', vox: 'Aixand Suite — Vox',
  }
  if (!titles[match[1]]) throw new Error('Unknown release component.')
  return `${titles[match[1]]} ${match[2]}`
}

export function releaseGuide(tag) {
  const component = tag.split('/')[0]
  const descriptions = {
    suite: 'Download hub for Aixand Suite (everything locally), Aixand Client (connect to a Server), and Aixand Server (host the workspace).',
    desktop: 'Full application: Client interface, local Server and included tool runtimes.',
    client: 'Installable Client application: interface and connection handling for an existing Aixand Server. No local Server or tool runtimes.',
    server: 'Server application: workspace backend and included tool runtimes. Connect using Aixand Client.',
    web: 'Web interface files used by deployment and component updates. This is not the installable Aixand Client application.',
  }
  const description = descriptions[component] || 'An independently released Aixand Suite component or developer library; not a full application installer.'
  return `<!-- aixand-product-guide -->\n${description}\n\nApplication installers: [Aixand Client](https://installer.aixand.org/aixand-suite/client) · [Aixand Server](https://installer.aixand.org/aixand-suite/server) · [Aixand Suite](https://installer.aixand.org/aixand-suite)\n<!-- /aixand-product-guide -->`
}

export function assetLabel(name, paths = new Map()) {
  if (paths.has(name)) return deliveryAssetName(paths.get(name))
  if (/^web-/.test(name)) return name.replace(/^web-/, 'aixand-client-web-assets-')
  if (/^aixand-desktop-/i.test(name)) return name.replace(/^aixand-desktop-/i, 'aixand-suite-')
  if (/^(?:suite-client|suite-server)-/.test(name)) name = name.replace(/^suite-/, 'aixand-')
  else if (/^suite-/.test(name)) name = name.replace(/^suite-/, 'aixand-suite-')
  const descriptions = {
    'INSTALLERS.json': 'Installer index — all three applications and their exact versions',
    'INSTALLERS-SHA256SUMS': 'Installer checksums — Suite, Client and Server',
    'RELEASE-NOTES.md': 'Download guide — choose Suite, Client or Server',
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
  const title = tag.startsWith('suite/') && !release.assets.some(asset => asset.name === 'INSTALLERS.json')
    ? releaseTitle(tag).replace(' — All installers', '') : releaseTitle(tag)
  const guide = releaseGuide(tag)
  const body = release.body?.includes('<!-- aixand-product-guide -->')
    ? release.body.replace(/<!-- aixand-product-guide -->[\s\S]*?<!-- \/aixand-product-guide -->/, guide)
    : guide + '\n\n' + (release.body || '')
  if (apply && (release.name !== title || release.body !== body)) {
    api(`repos/${repository}/releases/${release.id}`, '--method', 'PATCH', '-f', `name=${title}`, '-f', `body=${body}`)
  }
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
  return { tag, title, applied: apply, changes }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, option] = process.argv.slice(2)
    if (tag === '--title' && option && process.argv.length === 4) {
      console.log(releaseTitle(option))
    } else if (tag === '--notes' && option && process.argv.length === 4) {
      console.log(releaseGuide(option) + '\n\nExact component artifacts and composition are attached. See composition.json.')
    } else if (tag === '--upload-arguments' && option && process.argv.length === 4) {
      console.log(JSON.stringify(uploadArguments(option)))
    } else {
      if (!tag || (option && option !== '--apply') || process.argv.length > 4) throw new Error('Usage: node scripts/release/label-assets.mjs COMPONENT/vVERSION [--apply]')
      console.log(JSON.stringify(labelRelease(tag, option === '--apply'), null, 2))
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
