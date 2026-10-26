import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Historical manifests remain readable for upgrades; new packages always use
// shared independent tools and distinguish their user interface by role.
export function packageModel(root) {
  const file = join(root, 'manifest.json')
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const role = manifest.installation?.role || manifest.role || 'desktop'
  if (!['desktop', 'server'].includes(role)) throw new Error('Unsupported Aixand package role.')
  return { role, headless: role === 'server', legacyStandalone: manifest.installation?.edition === 'standalone' }
}
