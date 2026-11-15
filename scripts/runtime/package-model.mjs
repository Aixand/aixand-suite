import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Package role selects the interface; setup selects product ownership.
export function packageModel(root) {
  const file = join(root, 'manifest.json')
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const role = manifest.installation?.role || manifest.role || 'desktop'
  if (!['desktop', 'server'].includes(role)) throw new Error('Unsupported Aixand package role.')
  return { role, headless: role === 'server' }
}
