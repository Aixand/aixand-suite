import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Icon } from 'bbb-design'
import { folderLocations, readFolders, type FolderPage, type Folder } from '../auth/projectFolders'
import '../auth/project-onboarding.css'

export function ProjectFolderPicker({ initialPath, onSelect, onClose }: {
  initialPath: string; onSelect: (folder: Folder) => void; onClose: () => void
}) {
  const [page, setPage] = useState<FolderPage | null>(null)
  const [locations, setLocations] = useState<Folder[]>([])
  const [hidden, setHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)

  async function navigate(path: string, showHidden = hidden, cursor = 0) {
    const current = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await readFolders(false, path, '', { hidden: showHidden, cursor })
      if (current === generation.current) setPage(previous => cursor && previous?.path === next.path
        ? { ...next, entries: [...previous.entries, ...next.entries] } : next)
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not browse this folder.')
    } finally { if (current === generation.current) setLoading(false) }
  }

  useEffect(() => {
    let alive = true
    void folderLocations(false).then(value => {
      if (!alive) return
      setLocations(value.locations)
      void navigate(initialPath || value.initial)
    }).catch(cause => { if (alive) { setError(cause.message); setLoading(false) } })
    return () => { alive = false; generation.current++ }
  }, [])

  return <section className="project-folder-picker" aria-label="Browse project folders">
    <div className="project-folder-toolbar">
      <div className="project-folder-navigation">
      {locations.map(folder => <Button key={folder.path} variant="ghost" size="sm" onPress={() => void navigate(folder.path)}>{folder.name}</Button>)}
      </div>
      <div className="project-folder-tools">
        <Checkbox label="Show hidden folders" isSelected={hidden} onChange={value => { setHidden(value); if (page) void navigate(page.path, value) }} />
      <Button variant="ghost" size="sm" iconOnly aria-label="Close folder browser" onPress={onClose}><Icon name="x" /></Button>
      </div>
    </div>
    {page && <nav className="project-folder-breadcrumbs" aria-label="Folder breadcrumbs">
      {page.breadcrumbs.map(folder => <Button key={folder.path} variant="ghost" size="sm" aria-current={folder.path === page.path ? 'location' : undefined}
        onPress={() => void navigate(folder.path)}>{folder.name}</Button>)}
    </nav>}
    {error && <p role="alert">{error}</p>}
    <div className="project-folder-current">
      <span>{page?.name || 'Project folder'}</span>
      <Button variant="ghost" size="sm" disabled={!page?.parent || loading} onPress={() => { if (page?.parent) void navigate(page.parent) }}><Icon name="arrow-up" />Parent folder</Button>
    </div>
    <div className="project-folder-browser" aria-busy={loading}>
      <ul className="project-folder-rows">
      {page?.entries.map(folder => <li key={folder.path}><Button variant="ghost" className="project-folder-open" aria-label={`Open folder ${folder.name}`}
        onPress={() => void navigate(folder.path)}><Icon name="folder" /><span>{folder.name}</span><Icon name="chevron-right" /></Button></li>)}
      </ul>
      {!page?.entries.length && <div className="project-folder-empty"><Icon name="folder" /><p>{loading ? 'Loading folders…' : 'No subfolders here.'}</p></div>}
      {page?.nextCursor != null && <Button variant="ghost" disabled={loading} onPress={() => void navigate(page.path, hidden, page.nextCursor!)}>Load more folders</Button>}
    </div>
    <div className="project-folder-picker-footer"><Button variant="secondary" disabled={!page || loading || !!error} onPress={() => { if (page) onSelect(page) }}>Use this folder</Button></div>
  </section>
}
