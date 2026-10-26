import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Icon, Popover, TextField, Tooltip } from 'bbb-design'
import type { ProjectSelection, SetupState } from './agentSetup'
import { folderLocations, readFolders, type FolderPage, type Folder } from './projectFolders'
import { OnboardingActions } from './OnboardingActions'
import { ProjectFolderLocation } from './ProjectFolderLocation'
import { folderName, previewProjects } from './projectPreviewFolders'
import './project-onboarding.css'

// Keep browsing, selections, and names in memory when returning to agent setup.
export function ProjectOnboardingPreview({ active, onBack, preview = true, selection, onSave, onDraft, onComplete }: {
  active: boolean
  onBack: () => void
  preview?: boolean
  selection?: ProjectSelection
  onSave: (selection: ProjectSelection) => Promise<SetupState>
  onDraft: (selection: ProjectSelection) => void
  onComplete: (selection: ProjectSelection, skip: boolean) => Promise<SetupState>
}) {
  const [projects, setProjects] = useState<ProjectSelection['entries']>(selection?.entries ?? [])
  const [directory, setDirectory] = useState(selection?.directory || (preview ? previewProjects : ''))
  const [location, setLocation] = useState(directory)
  const [page, setPage] = useState<FolderPage | null>(null)
  const [locations, setLocations] = useState<(Folder & { id: string })[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [hidden, setHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pathError, setPathError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState<'browse' | 'selected'>('browse')
  const [editingLocation, setEditingLocation] = useState(false)
  const [editingName, setEditingName] = useState<{ id: string; original: string } | null>(null)
  const editLocationButton = useRef<HTMLButtonElement>(null)
  const renameButtons = useRef(new Map<string, HTMLButtonElement>())
  const directoryHeading = useRef<HTMLHeadingElement>(null)
  const selectedHeading = useRef<HTMLHeadingElement>(null)
  const generation = useRef(0)
  const latest = useRef({ onSave, onDraft, onComplete }); latest.current = { onSave, onDraft, onComplete }
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)
  const folders = page?.entries ?? []
  const selected = (path: string) => projects.some(project => project.path === path)
  const nameError = (project: ProjectSelection['entries'][number]) => !project.name.trim() ? 'Enter a project name.'
    : projects.some(other => other.id !== project.id && other.name.trim().toLowerCase() === project.name.trim().toLowerCase())
      ? 'Choose a different name. This name is already in your list.' : ''
  const valid = projects.length > 0 && projects.every(project => !nameError(project))
  const home = locations.find(row => row.id === 'home')
  const homeIndex = page?.breadcrumbs.findIndex(part => part.path === home?.path) ?? -1
  const breadcrumbs = page?.breadcrumbs.slice(homeIndex >= 0 ? homeIndex + 1 : 0) ?? []
  const selectionValue = (): ProjectSelection => ({ directory, entries: projects, skipped: false })
  useEffect(() => {
    if (!active || !dirty.current) return
    // Closing the screen must include edits made before the autosave delay.
    latest.current.onDraft({ directory, entries: projects, skipped: false })
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void latest.current.onSave({ directory, entries: projects, skipped: false }).then(() => setSaveError('')).catch(error => setSaveError(error.message))
    }, 350)
    return () => clearTimeout(saveTimer.current)
  }, [active, directory, projects])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void folderLocations(preview).then(value => {
      if (cancelled) return
      setLocations(value.locations)
      void navigate(directory || value.initial)
    }).catch(error => { if (!cancelled) { setPathError(error.message); setEditingLocation(true) } })
    return () => { cancelled = true; generation.current++ }
    // Restore the last location once when entering the explorer.
  }, [active, preview])
  useEffect(() => {
    if (!active || !location) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void readFolders(preview, location, directory, { suggest: true, hidden, signal: controller.signal })
        .then(value => { if (!controller.signal.aborted) setSuggestions(value.entries.map(row => row.path)) })
        .catch(() => { if (!controller.signal.aborted) setSuggestions([]) })
    }, preview ? 0 : 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [active, preview, location, directory, hidden])
  async function navigate(value: string, focus = false, cursor?: number, showHidden = hidden) {
    const current = ++generation.current
    setLoading(true)
    try {
      const next = await readFolders(preview, value, directory, { hidden: showHidden, cursor })
      if (current !== generation.current) return
      setPage(previous => cursor && previous?.path === next.path ? { ...next, entries: [...previous.entries, ...next.entries] } : next)
      setDirectory(next.path); setLocation(next.path); setPathError(''); setEditingLocation(false); dirty.current = true
      setNotice(`Browsing ${next.path}.`)
      if (focus) requestAnimationFrame(() => directoryHeading.current?.focus({ preventScroll: true }))
    } catch (error) { if (current === generation.current) { setPathError(error instanceof Error ? error.message : 'Could not browse this folder.'); setEditingLocation(true) } }
    finally { if (current === generation.current) setLoading(false) }
  }
  async function finish(skip: boolean) {
    clearTimeout(saveTimer.current); setBusy(true); setSaveError('')
    try {
      const result = await latest.current.onComplete(selectionValue(), skip)
      if (result.projects) setProjects(result.projects.entries)
      if (result.status !== 'complete' && !preview) {
        setSaveError('Some projects could not be added. Review their errors and retry, or remove them from your selection.')
        showView('selected')
      }
    } catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not finish setup.') }
    finally { setBusy(false) }
  }
  async function back() {
    clearTimeout(saveTimer.current); setBusy(true)
    try { await latest.current.onSave(selectionValue()); onBack() }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Could not save setup.') }
    finally { setBusy(false) }
  }

  function toggleFolder(path: string, include: boolean) {
    dirty.current = true
    if (!include) {
      setProjects(current => current.filter(project => project.path !== path))
      setNotice(`${folderName(path)} removed from your projects.`)
      return
    }
    if (selected(path)) return
    const base = (folders.find(row => row.path === path)?.name ?? (path === page?.path ? page.name : folderName(path))).slice(0, 120)
    let name = base
    let suffix = 2
    while (projects.some(project => project.name.trim().toLowerCase() === name.toLowerCase())) name = `${base}-${suffix++}`
    setProjects(current => [...current, { id: path, path, name }])
    setNotice(`${name} included in your projects.`)
  }

  function showView(next: 'browse' | 'selected') {
    setView(next)
    setEditingLocation(false)
    requestAnimationFrame(() => (next === 'selected' ? selectedHeading : directoryHeading).current?.focus({ preventScroll: true }))
  }
  function closeLocation() {
    setLocation(directory); setPathError(''); setEditingLocation(false)
    requestAnimationFrame(() => editLocationButton.current?.focus())
  }
  function rename(id: string, name: string) {
    dirty.current = true
    setProjects(current => current.map(row => row.id === id ? { ...row, name, error: undefined } : row))
  }
  function finishEditingName(id: string) {
    setEditingName(null)
    requestAnimationFrame(() => renameButtons.current.get(id)?.focus())
  }

  if (!active) return null
  return <div className="project-onboarding">
    <fieldset disabled={busy} className="project-onboarding-layout">
      <div className="project-folder-toolbar">
        {view === 'selected' ? <h2 ref={selectedHeading} tabIndex={-1}>Selected projects</h2>
          : editingLocation ? <form className="project-folder-location" onSubmit={event => { event.preventDefault(); void navigate(location, true) }}>
            <ProjectFolderLocation value={location} current={directory} suggestions={suggestions} error={pathError} autoFocus
              onCancel={closeLocation} onChange={value => { setLocation(value); setPathError('') }} onNavigate={path => navigate(path, true)} />
            <Button type="submit" variant="ghost" iconOnly aria-label="Open folder path" disabled={!location.trim()}><Icon name="arrow-right" /></Button>
            <Button variant="ghost" iconOnly aria-label="Cancel editing folder location" onPress={closeLocation}><Icon name="x" /></Button>
          </form> : <div className="project-folder-navigation">
            <nav className="project-folder-breadcrumbs" aria-label="Folder breadcrumbs">
              {home && <Button variant="ghost" size="sm" iconOnly aria-label="Home" aria-current={home.path === directory ? 'location' : undefined} onPress={() => void navigate(home.path, true)}><Icon name="house" /></Button>}
              {breadcrumbs.map(part => <span key={part.path}>
                <Icon name="chevron-right" />
                <Button variant="ghost" size="sm" aria-current={part.path === directory ? 'location' : undefined} onPress={() => void navigate(part.path, true)}>{part.name}</Button>
              </span>)}
            </nav>
            <Tooltip content="Edit folder location"><Button ref={editLocationButton} variant="ghost" size="sm" iconOnly aria-label="Edit folder location" onPress={() => { setLocation(directory); setEditingLocation(true) }}><Icon name="pencil" /></Button></Tooltip>
          </div>}
        {!editingLocation && <div className="project-folder-tools">
          {view === 'browse' && !preview && <Popover title="Folder options" trigger={<Button variant="ghost" iconOnly aria-label="Folder options"><Icon name="ellipsis" /></Button>}>
            <Checkbox label="Show hidden folders" isSelected={hidden} onChange={value => { setHidden(value); void navigate(directory, false, undefined, value) }} />
          </Popover>}
          <Button variant={view === 'selected' ? 'ghost' : 'secondary'} size="sm" aria-label={view === 'selected' ? 'Back to folders' : `Selected projects (${projects.length})`}
            onPress={() => showView(view === 'selected' ? 'browse' : 'selected')}>
            {view === 'selected' ? <><Icon name="arrow-left" />Folders</> : <>Selected ({projects.length})</>}
          </Button>
        </div>}
      </div>
      {view === 'browse' ? <section className="project-folder-browser" aria-label="Browse folders">
        <div className="project-folder-directory" aria-busy={loading}>
          <div className="project-folder-current" data-selected={selected(directory)}>
            <h2 ref={directoryHeading} tabIndex={-1} className="bbb-visually-hidden">{page?.name ?? 'Loading folders…'}</h2>
            <Checkbox label="Add this folder" disabled={!page || loading} isSelected={selected(directory)} onChange={include => toggleFolder(directory, include)} />
            <Button variant="ghost" size="sm" iconOnly aria-label="Go to parent folder" disabled={!page?.parent || loading} onPress={() => { if (page?.parent) void navigate(page.parent) }}><Icon name="arrow-up" /></Button>
          </div>
          {folders.length ? <ul className="project-folder-rows" aria-label={`Folders in ${directory}`}>
            {folders.map(({ path, name }) => <li key={path} data-selected={selected(path)}>
              <Checkbox label={`Include ${name}`} hideLabel isSelected={selected(path)} onChange={include => toggleFolder(path, include)} />
              <Button variant="ghost" className="project-folder-open" aria-label={`Open folder ${name}`} onPress={() => navigate(path, true)}>
                <Icon name="folder" /><span>{name}</span><Icon name="chevron-right" />
              </Button>
            </li>)}
          </ul> : <div className="project-folder-empty"><Icon name="folder" /><p>{loading ? 'Loading folders…' : 'No subfolders here.'}</p></div>}
        </div>
        {page?.nextCursor !== null && page?.nextCursor !== undefined && <Button variant="secondary" disabled={loading} onPress={() => void navigate(directory, false, page.nextCursor!)}>Load more folders</Button>}
      </section> : <section className="project-onboarding-list" aria-label="Selected projects">
        {projects.length ? <ul aria-label="Selected projects">
          {projects.map(project => <li key={project.id} aria-label={project.path}>
            <div className="project-onboarding-project-name">
              <Icon name="folder" />
              {editingName?.id === project.id ? <form className="project-onboarding-rename" onSubmit={event => {
                event.preventDefault()
                if (!nameError(project)) { rename(project.id, project.name.trim()); finishEditingName(project.id) }
              }} onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  if (editingName?.id === project.id) rename(project.id, editingName.original)
                  finishEditingName(project.id)
                }
              }}>
                <TextField label={`Project name for ${project.path}`} hideLabel variant="outlined" value={project.name} maxLength={128} autoFocus
                  placeholder={folderName(project.path)} error={nameError(project) || undefined}
                  onChange={event => rename(project.id, event.target.value)} onBlur={() => rename(project.id, project.name.trim())} />
                <Button type="submit" variant="ghost" size="sm" iconOnly aria-label={`Save project name for ${project.path}`} disabled={!!nameError(project)}><Icon name="check" /></Button>
              </form> : <>
                <strong>{project.name || folderName(project.path)}</strong>
                <Tooltip content="Rename project"><Button ref={element => { if (element) renameButtons.current.set(project.id, element); else renameButtons.current.delete(project.id) }} variant="ghost" size="sm" iconOnly aria-label={`Rename project ${project.path}`} onPress={() => setEditingName({ id: project.id, original: project.name })}><Icon name="pencil" /></Button></Tooltip>
              </>}
              <Button variant="ghost" iconOnly aria-label={`Remove folder ${project.path}`} onPress={() => {
                toggleFolder(project.path, false)
                selectedHeading.current?.focus({ preventScroll: true })
              }}><Icon name="x" /></Button>
            </div>
            <span className="project-onboarding-project-path">{project.path}</span>
            {(project.error || editingName?.id !== project.id && nameError(project)) && <p role="alert" className="auth-error">{project.error || nameError(project)}</p>}
          </li>)}
        </ul> : <div className="project-onboarding-empty">
          <Icon name="folder" /><p>No folders selected.</p>
          <Button variant="ghost" onPress={() => showView('browse')}>Browse folders</Button>
        </div>}
      </section>}
    </fieldset>
    {saveError && <p role="alert" className="auth-error">{saveError}</p>}
    {projects.some(project => nameError(project)) && view === 'browse' && <Button variant="ghost" onPress={() => showView('selected')}>Review project names<Icon name="arrow-right" /></Button>}
    <p role="status" className="bbb-visually-hidden">{notice}</p>
    <OnboardingActions className="project-onboarding-footer">
      <Button variant="ghost" aria-label="Back to agents" disabled={busy} onPress={() => void back()}><Icon name="arrow-left" />Back</Button>
      <div className="project-onboarding-finish">
        {projects.length ? <Button disabled={!valid || busy} loading={busy} onPress={() => void finish(false)}>Finish setup<Icon name="arrow-right" /></Button>
          : <Button disabled={busy} loading={busy} onPress={() => void finish(true)}>Skip for now<Icon name="arrow-right" /></Button>}
      </div>
    </OnboardingActions>
  </div>
}
