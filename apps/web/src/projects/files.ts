export type ProjectFileEntry = {
  name: string
  path: string
  kind: 'directory' | 'file' | 'link' | 'other'
  size: number
  modifiedAt: number
  supported: boolean
}
export type ProjectDirectory = {
  projectId: string
  path: string
  entries: ProjectFileEntry[]
  total: number
  limited: boolean
  nextOffset: number | null
}
export type ProjectFile = {
  projectId: string
  path: string
  name: string
  size: number
  modifiedAt: number
  truncated: boolean
} & ({ kind: 'text'; content: string } | { kind: 'image'; mime: string; content: string } |
  { kind: 'unsupported'; message: string })

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const compactQuery = '(max-width: 1100px)'
export const projectFilesCompact = () => window.matchMedia(compactQuery).matches
export function subscribeProjectFilesLayout(callback: () => void) {
  const query = window.matchMedia(compactQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}
