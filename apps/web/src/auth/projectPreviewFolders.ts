// A small, navigable filesystem for onboarding previews. Never probes the host.
export const previewHome = '/home/you'
export const previewProjects = `${previewHome}/projects`

const leaves = [
  '/home/shared/assets', '/home/shared/team-site',
  `${previewHome}/Documents/notes`, `${previewHome}/Downloads`,
  `${previewProjects}/api/src`, `${previewProjects}/api/tests`,
  `${previewProjects}/mobile-app/assets`, `${previewProjects}/mobile-app/src`,
  `${previewProjects}/website/public`, `${previewProjects}/website/src`,
  `${previewHome}/work/design-system`, `${previewHome}/work/website`,
  '/opt/projects/internal-tools',
]

export const previewFolders = new Set(['/', ...leaves.flatMap(path => {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
})])

export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? 'Root'
export const parentFolder = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'
export const childFolders = (path: string) => [...previewFolders]
  .filter(folder => folder !== '/' && parentFolder(folder) === path)
  .sort((a, b) => a.localeCompare(b))

export function resolvePreviewPath(value: string, current: string) {
  let path = value.trim()
  if (path === '~' || path.startsWith('~/')) path = previewHome + path.slice(1)
  if (!path.startsWith('/')) path = `${current}/${path}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function suggestedFolders(value: string, current: string) {
  const path = resolvePreviewPath(value, current)
  if (previewFolders.has(path)) return childFolders(path)
  return childFolders(parentFolder(path)).filter(folder => folder.toLowerCase().startsWith(path.toLowerCase()))
}
