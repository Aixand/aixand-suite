import { childFolders, folderName, parentFolder, previewFolders, previewHome, previewProjects, resolvePreviewPath, suggestedFolders } from './projectPreviewFolders'
export type Folder = { name: string; path: string }
export type FolderPage = { path: string; name: string; parent: string | null; breadcrumbs: Folder[]; entries: Folder[]; total: number; nextCursor: number | null }
export async function filesystem<T>(resource: string, params?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/filesystem/${resource}${params ? `?${new URLSearchParams(params)}` : ''}`, { credentials: 'same-origin', cache: 'no-store', signal })
  const value = await response.json()
  if (!response.ok) throw new Error(value.message ?? 'Could not browse this directory.')
  return value
}
export async function folderLocations(preview: boolean) {
  return preview ? { initial: previewProjects, locations: [{ id: 'home', name: 'Home', path: previewHome }, { id: 'workspace', name: 'Projects', path: previewProjects }] }
    : filesystem<{ initial: string; locations: (Folder & { id: string })[] }>('locations')
}
export async function readFolders(preview: boolean, path: string, base: string, options: { suggest?: boolean; hidden?: boolean; cursor?: number; signal?: AbortSignal } = {}): Promise<FolderPage> {
  if (!preview) return filesystem('directories', { path, ...(base ? { base } : {}), hidden: String(!!options.hidden), suggest: String(!!options.suggest), cursor: String(options.cursor ?? 0) }, options.signal)
  const resolved = resolvePreviewPath(path, base || previewProjects)
  if (!options.suggest && !previewFolders.has(resolved)) throw new Error('This folder isn’t in the preview. Choose a suggestion or browse from Home.')
  const paths = options.suggest ? suggestedFolders(path, base) : childFolders(resolved)
  const parts = resolved.split('/').filter(Boolean)
  return { path: resolved, name: folderName(resolved), parent: resolved === '/' ? null : parentFolder(resolved),
    breadcrumbs: [{ name: 'Root', path: '/' }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` }))],
    entries: paths.map(path => ({ path, name: folderName(path) })), total: paths.length, nextCursor: null }
}
