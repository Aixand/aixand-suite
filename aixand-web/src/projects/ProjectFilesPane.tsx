import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Button, Icon, Tooltip } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { PageLoading } from '../components/PageLoading'
import type { Project } from './model'
import { fileSize, type ProjectDirectory, type ProjectFile } from './files'
import './files.css'

export function ProjectFilesPane({ project, agents, onClose }: {
  project: Project
  agents: AgentsModel
  onClose?: () => void
}) {
  const api = useRef(agents)
  api.current = agents
  const [directory, setDirectory] = useState('')
  const [hidden, setHidden] = useState(false)
  const [listing, setListing] = useState<ProjectDirectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [listingError, setListingError] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [reading, setReading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const listingSequence = useRef(0)
  const fileSequence = useRef(0)
  const selectedRow = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const sequence = ++listingSequence.current
    setListing(null)
    setListingError('')
    if (agents.status !== 'connected') { setLoading(false); return }
    setLoading(true)
    void api.current.request<ProjectDirectory>('project-files-list', { projectId: project.id, path: directory, hidden })
      .then((result) => {
        if (!result || !Array.isArray(result.entries)) throw new Error('The project file listing is unavailable. Try refreshing.')
        if (listingSequence.current === sequence) setListing(result)
      })
      .catch((cause: Error) => { if (listingSequence.current === sequence) setListingError(cause.message) })
      .finally(() => { if (listingSequence.current === sequence) setLoading(false) })
    return () => { listingSequence.current += 1 }
  }, [project.id, directory, hidden, refresh, agents.status])

  useEffect(() => {
    const sequence = ++fileSequence.current
    setFile(null)
    setFileError('')
    if (!selectedPath || agents.status !== 'connected') { setReading(false); return }
    setReading(true)
    void api.current.request<ProjectFile>('project-file-read', { projectId: project.id, path: selectedPath })
      .then((result) => {
        if (!result || !['text', 'image', 'unsupported'].includes(result.kind)) throw new Error('The file preview is unavailable. Try refreshing.')
        if (fileSequence.current === sequence) setFile(result)
      })
      .catch((cause: Error) => { if (fileSequence.current === sequence) setFileError(cause.message) })
      .finally(() => { if (fileSequence.current === sequence) setReading(false) })
    return () => { fileSequence.current += 1 }
  }, [project.id, selectedPath, refresh, agents.status])

  async function loadMore() {
    if (loading || listing?.nextOffset == null) return
    const sequence = listingSequence.current
    setLoading(true)
    setListingError('')
    try {
      const next = await api.current.request<ProjectDirectory>('project-files-list', {
        projectId: project.id, path: directory, hidden, offset: listing.nextOffset,
      })
      if (sequence === listingSequence.current)
        setListing((previous) => previous && ({ ...next, entries: [...new Map(
          [...previous.entries, ...next.entries].map((entry) => [entry.path, entry])).values()] }))
    } catch (cause) {
      if (sequence === listingSequence.current) setListingError(cause instanceof Error ? cause.message : 'Could not load files.')
    } finally {
      if (sequence === listingSequence.current) setLoading(false)
    }
  }

  const parts = directory ? directory.split('/') : []
  const connected = agents.status === 'connected'
  return <section className="project-files" aria-label="Project files">
    <header className="project-files-heading">
      <div><h2>Files</h2><p title={project.path}>{project.name}</p></div>
      <div className="project-files-actions">
        <Tooltip content="Refresh files"><Button variant="ghost" size="sm" iconOnly aria-label="Refresh files"
          disabled={!connected || loading || reading} onPress={() => setRefresh((value) => value + 1)}><Icon name="refresh-cw" /></Button></Tooltip>
        {onClose && <Tooltip content="Hide project files"><Button variant="ghost" size="sm" iconOnly aria-label="Hide project files"
          onPress={onClose}><Icon name="panel-right" /></Button></Tooltip>}
      </div>
    </header>
    <nav className="project-files-breadcrumbs" aria-label="Project folders">
      <Button variant="ghost" size="sm" aria-current={!directory ? 'location' : undefined}
        onPress={() => setDirectory('')}><Icon name="folder" />{project.name}</Button>
      {parts.map((part, index) => <span key={parts.slice(0, index + 1).join('/')}>
        <Icon name="chevron-right" /><Button variant="ghost" size="sm"
          aria-current={index === parts.length - 1 ? 'location' : undefined}
          onPress={() => setDirectory(parts.slice(0, index + 1).join('/'))}>{part}</Button>
      </span>)}
    </nav>
    <div className="project-files-options"><label><input type="checkbox" checked={hidden}
      onChange={(event) => setHidden(event.target.checked)} />Hidden files</label>
      <span>{listing ? `${listing.entries.length}${listing.nextOffset !== null ? ` / ${listing.total}` : ''} ${listing.total === 1 ? 'item' : 'items'}` : ''}</span>
    </div>
    <div className="project-files-list">
      {!connected && <p role="status">Reconnect to browse this project’s files.</p>}
      {loading && !listing && <PageLoading label="Loading project files…" size="panel" />}
      {listingError && <div className="project-files-error"><p role="alert">{listingError}</p>
        <Button variant="ghost" size="sm" disabled={!connected || loading} onPress={() => setRefresh((value) => value + 1)}>Retry files</Button></div>}
      {listing && <>
        {listing.entries.length ? <ul aria-label={`Files in ${directory || 'project root'}`}>
          {listing.entries.map((entry) => <li key={entry.path} title={entry.supported ? entry.path : 'Linked paths and special files cannot be opened'}>
            <Button ref={entry.path === selectedPath ? selectedRow : undefined} variant="ghost" className="project-file-row"
              aria-label={`Open ${entry.kind === 'directory' ? 'folder' : 'file'} ${entry.name}`}
              aria-current={entry.path === selectedPath ? 'true' : undefined} disabled={!entry.supported || !connected}
              onPress={() => entry.kind === 'directory' ? setDirectory(entry.path) : setSelectedPath(entry.path)}>
              <Icon name={entry.kind === 'directory' ? 'folder' : 'file-text'} />
              <span>{entry.name}</span>
              {entry.kind === 'directory' ? <Icon name="chevron-right" /> : <small>{entry.kind === 'file' ? fileSize(entry.size) : entry.kind}</small>}
            </Button>
          </li>)}
        </ul> : <p className="project-files-empty">{hidden ? 'This folder is empty.' : 'No visible files. Enable hidden files to see more.'}</p>}
        {listing.nextOffset !== null && <Button variant="ghost" size="sm" disabled={loading || !connected} onPress={() => void loadMore()}>
          {loading ? 'Loading…' : 'Load more files'}</Button>}
        {listing.limited && <p className="project-files-limit">This folder is large; the listing is limited to 5,000 scanned entries.</p>}
      </>}
    </div>
    <section className="project-file-preview" aria-label="File preview">
      <header><div><h3 title={selectedPath ?? undefined}>{selectedPath ?? 'File preview'}</h3>
        <span>{file ? `${fileSize(file.size)} · Read only` : 'Read only'}</span></div>
        {selectedPath && <Tooltip content="Close file preview"><Button variant="ghost" size="sm" iconOnly aria-label="Close file preview"
          onPress={() => { setSelectedPath(null); selectedRow.current?.focus() }}><Icon name="x" /></Button></Tooltip>}
      </header>
      <div className="project-file-preview-body">
        {!selectedPath && <div className="project-file-preview-empty"><Icon name="file-text" /><p>Select a file to read it alongside your chat.</p></div>}
        {selectedPath && !connected && <p role="status">Reconnect to read this file.</p>}
        {reading && <PageLoading label="Reading file…" size="panel" />}
        {fileError && <div className="project-files-error"><p role="alert">{fileError}</p><Button variant="ghost" size="sm"
          disabled={!connected || reading} onPress={() => setRefresh((value) => value + 1)}>Retry preview</Button></div>}
        {file?.kind === 'text' && (file.content ? <pre tabIndex={0} aria-label={`Contents of ${file.name}`}><code>{file.content}</code></pre> :
          <p className="project-files-empty">This file is empty.</p>)}
        {file?.kind === 'image' && <img className="project-file-image" src={`data:${file.mime};base64,${file.content}`} alt={`Preview of ${file.name}`} />}
        {file?.kind === 'unsupported' && <p className="project-files-empty">{file.message}</p>}
      </div>
      {file?.truncated && <p className="project-files-limit" role="status">Showing the first 256 KiB of this file.</p>}
    </section>
  </section>
}

export function ProjectFilesResize({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const drag = useRef<{ start: number; width: number } | null>(null)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const maximum = Math.max(280, Math.min(720, Math.floor(viewportWidth * .45)))
  const effectiveWidth = Math.min(maximum, width)
  function resize(value: number) { onChange(Math.max(280, Math.min(maximum, value))) }
  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { start: event.clientX, width: effectiveWidth }
  }
  return <div className="project-files-resize" role="separator" tabIndex={0} aria-label="Resize project files"
    aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maximum} aria-valuenow={effectiveWidth}
    onPointerDown={start} onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.start - event.clientX) }}
    onPointerUp={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}
    onDoubleClick={() => resize(384)} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      resize(event.key === 'Home' ? 280 : event.key === 'End' ? maximum : effectiveWidth + (event.key === 'ArrowLeft' ? 24 : -24))
    }} />
}
