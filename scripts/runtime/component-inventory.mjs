// Read-only component discovery and removal choices.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { discoverInstallation } from './installation-plan.mjs'
import { inside } from './platform.mjs'
import { sharedToolData } from './cleanup.mjs'

export function applicationAt(directory) {
  const path = join(directory, 'server-installation.json')
  if (!existsSync(path)) return null
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  if (saved.schema !== 1 || saved.application !== 'org.aixand.server' || typeof saved.directory !== 'string' || !isAbsolute(saved.workspace || '') || resolve(saved.directory) !== resolve(directory))
    throw new Error('The application installation record is invalid: ' + path)
  return { directory: resolve(directory), workspace: saved.workspace, build: saved.build }
}

export async function componentInventory(root, input, base, directory) {
  const found = await discoverInstallation(root, input, base)
  const application = directory ? applicationAt(directory) : null
  const sharedData = sharedToolData({ root, input, base, env: { HOME: input.HOME || input.USERPROFILE } })
  const workspacePresent = ['runtime.json', 'config/installation-plan.json', 'config/product-installation.json', 'config/setup.json', 'auth', 'chats', 'agents', 'software/products'].some(name => existsSync(join(base, name)))
  return { ...found, found: found.found || sharedData.length > 0 || workspacePresent || Boolean(application), application, sharedData,
    workspace: { path: base, present: workspacePresent },
    tools: found.tools.map(tool => ({ ...tool, location: inside(realpathSync(tool.path), found.productPrefix) ? 'product-store' : 'external' })) }
}

export function removalChoices(items) {
  const available = items.filter(item => item.available && item.present !== false && !item.recovery)
  const software = available.filter(item => item.id.startsWith('product:') || item.id === 'private-products' || item.id.startsWith('provider:') || ['provider-runtime', 'provider-tool-store', 'provider-shared-runtime'].includes(item.id))
  const data = available.filter(item => !software.includes(item))
  return { software, data }
}

export function removalDataChoices(data, target) {
  if (target === 'application') return data.filter(item => !item.shared)
  if (target === 'tools') return data.filter(item => item.id !== 'workspace')
  return data
}
