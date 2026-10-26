import { useEffect, useId, useRef, useState } from 'react'
import { Button, Checkbox, Icon, Textarea, TextField, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { requestId } from '../terminals/connection'
import { DiscoveryCards } from './DiscoveryCards'
import { discoveryActive, discoveryFilterActive, discoveryFilterSummary, discoverySummary, type DiscoveryCandidate, type DiscoveryFilter, type ProjectsModel } from './model'
import './discovery.css'

export function DiscoverProjects({ open, onOpenChange, jobId, onSelectJob, projects, connected }: {
  open: boolean; onOpenChange: (open: boolean) => void; jobId: string | null;
  onSelectJob: (id: string | null) => void; projects: ProjectsModel; connected: boolean
}) {
  const theme = useThemeAttributes()
  const descriptionId = useId()
  const [root, setRoot] = useState('')
  const [includeNested, setIncludeNested] = useState(false)
  const [exclude, setExclude] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const startAttempt = useRef<{ signature: string; key: string } | null>(null)
  const importAttempt = useRef<{ signature: string; key: string } | null>(null)
  const filterAttempt = useRef<{ signature: string; key: string } | null>(null)
  const api = useRef(projects)
  api.current = projects
  const job = projects.discoveries.find((row) => row.id === jobId)
  const filterSignature = JSON.stringify(job?.resultFilter ?? { scope: 'all', query: '' })
  const canImport = job && ['completed', 'partial', 'failed'].includes(job.state) && (!job.error || job.registration !== null)

  useEffect(() => {
    setCandidates([]); setSelected(new Set()); setNextOffset(null); setError('')
    if (open && jobId && connected) void api.current.getDiscovery(jobId).catch((cause: Error) => setError(cause.message))
  }, [open, jobId, connected])
  useEffect(() => {
    setSelected(new Set()); setCandidates([]); setNextOffset(null)
    setFilterQuery((JSON.parse(filterSignature) as DiscoveryFilter).query)
  }, [jobId, filterSignature])
  useEffect(() => {
    if (!open || !jobId || !connected || !job || discoveryActive(job)) return
    let current = true
    void api.current.discoveryResults(jobId).then((value) => {
      if (current) { setCandidates(value.candidates); setNextOffset(value.nextOffset) }
    }).catch((cause: Error) => { if (current) setError(cause.message) })
    return () => { current = false }
  }, [open, connected, jobId, job?.state, job?.revision])

  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await operation() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Discovery action failed.') }
    finally { setBusy(false) }
  }
  async function start(mode: 'preview' | 'add') {
    const args = { root: root.trim(), mode, includeNested, exclude: exclude.split('\n').map((value) => value.trim()).filter(Boolean) }
    const signature = JSON.stringify(args)
    if (startAttempt.current?.signature !== signature) startAttempt.current = { signature, key: requestId() }
    const result = await projects.startDiscovery({ ...args, key: startAttempt.current.key })
    startAttempt.current = null
    onSelectJob(result.id)
  }
  async function filter(value: DiscoveryFilter) {
    if (!jobId) return
    const signature = JSON.stringify([jobId, value])
    if (filterAttempt.current?.signature !== signature) filterAttempt.current = { signature, key: requestId() }
    await projects.filterDiscovery(filterAttempt.current.key, jobId, value)
    filterAttempt.current = null
  }
  async function register(selection: 'recommended' | 'filtered' | string[]) {
    if (!jobId) return
    const signature = JSON.stringify([jobId, selection])
    if (importAttempt.current?.signature !== signature) importAttempt.current = { signature, key: requestId() }
    const result = await projects.importDiscovery(importAttempt.current.key, jobId, selection)
    if (!result.error) { importAttempt.current = null; setSelected(new Set()) }
  }
  return <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={open} isDismissable={!busy}
    onOpenChange={(value) => { if (!busy) onOpenChange(value) }}>
    <Modal className="bbb-modal project-discovery-modal">
      <Dialog className="bbb-dialog" aria-describedby={descriptionId}>
        <div className="bbb-dialog__header">
          <div className="bbb-dialog__heading"><Heading slot="title">Discover projects</Heading>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close discovery" disabled={busy} onPress={() => onOpenChange(false)}><Icon name="x" /></Button>
          </div>
          <p id={descriptionId} className="bbb-dialog__description">Find projects in a directory on the machine running Aixand Suite.</p>
        </div>
        <div className="bbb-dialog__body">
          {!jobId ? <>
            <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void act(() => start('preview')) }}>
              <TextField label="Starting directory" value={root} maxLength={4096} required autoFocus disabled={busy}
                placeholder="~/projects" onChange={(event) => setRoot(event.target.value)} />
              <Checkbox label="Include nested packages" isSelected={includeNested} onChange={setIncludeNested} disabled={busy} />
              <Textarea label="Extra exclusions (one pattern per line)" rows={3} maxLength={16384} value={exclude} disabled={busy}
                onChange={(event) => setExclude(event.target.value)} placeholder="archived\nexperiments/*" />
              <div className="command-project-form-actions">
                <Button type="submit" variant="ghost" disabled={!connected || busy || !root.trim()}>Preview projects</Button>
                <Button disabled={!connected || busy || !root.trim()} onPress={() => { void act(() => start('add')) }}>Discover and add</Button>
              </div>
            </form>
            <DiscoveryCards jobs={projects.discoveries.slice(0, 20)} connected={connected} onView={onSelectJob} />
          </> : job ? <>
            <p className="project-discovery-path"><strong>{job.root}</strong></p>
            <p role="status">{discoveryActive(job) ? job.state === 'registering' ? 'Adding projects…' : 'Discovering projects…' : job.state === 'partial' ? 'Completed with gaps' : job.state === 'completed' ? 'Completed' : job.state === 'cancelled' ? 'Stopped' : job.state === 'interrupted' ? 'Interrupted' : 'Could not finish'}</p>
            <p>{discoverySummary(job)}</p>
            {job.error && <p role="alert">{job.error}</p>}
            {!job.scanComplete && !discoveryActive(job) && <p>Coverage is incomplete. Some locations could not be fully inspected.</p>}
            {!!job.reasons.length && <p>Coverage details: {job.reasons.map((reason) => reason.replaceAll('-', ' ')).join(', ')}.</p>}
            {!!job.warnings.length && <details><summary>Locations to review ({job.stats.warnings ?? job.warnings.length})</summary>
              {job.warnings.map((warning, index) => <p className="project-discovery-path" key={index}>{warning.path}: {warning.message}</p>)}
            </details>}
            <details><summary>Excluded directories</summary><p>{job.defaultExclusions.join(', ')}{job.exclude.length ? `; extra patterns: ${job.exclude.join(', ')}` : ''}</p></details>
            <form className="form-stack project-discovery-filters" aria-label="Discovery filters" onSubmit={(event) => {
              event.preventDefault()
              void act(() => filter({ ...job.resultFilter, scope: job.resultFilter?.scope ?? 'all', query: filterQuery.trim() }))
            }}>
              <Checkbox label="Show project roots only" isSelected={job.resultFilter?.scope === 'roots'} disabled={!connected || busy}
                onChange={(checked) => { void act(() => filter({ ...job.resultFilter, scope: checked ? 'roots' : 'all', query: filterQuery.trim() })) }} />
              <TextField label="Filter by name or path" value={filterQuery} maxLength={512} disabled={!connected || busy}
                placeholder="undercurrent" onChange={(event) => setFilterQuery(event.target.value)} />
              {job.resultFilter?.candidateIds !== undefined && <p>Showing a selected set of projects.</p>}
              <div className="command-project-form-actions">
                <Button type="submit" variant="ghost" disabled={!connected || busy}>Apply filter</Button>
                <Button variant="ghost" disabled={!connected || busy || !discoveryFilterActive(job)}
                  onPress={() => { void act(() => filter({ scope: 'all', query: '' })) }}>Clear filters</Button>
              </div>
            </form>
            {discoveryFilterActive(job) && <p>{discoveryFilterSummary(job)}</p>}
            {!discoveryActive(job) && job.filtered?.matched === 0 && <p>{discoveryFilterActive(job) ? 'No projects match these filters.' : 'No projects were discovered.'}</p>}
            {!!candidates.length && <div className="project-discovery-candidates" aria-label="Discovered projects">
              {candidates.map((row) => <div className="project-discovery-candidate" key={row.id}>
                <Checkbox label={row.suggestedName} isSelected={selected.has(row.id)} disabled={!canImport || busy || !!row.existingProjectIds.length || row.unavailable}
                  onChange={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(row.id); else next.delete(row.id); return next })} />
                <small className="project-discovery-path">{row.path}</small>
                <small>{row.unavailable ? 'Directory unavailable' : row.existingProjectIds.length ? 'Already registered' : row.classification === 'nested' ? 'Nested package' : 'Project root'} · {row.signals.join(', ')}</small>
              </div>)}
            </div>}
            {nextOffset !== null && <Button variant="ghost" disabled={busy || !connected} onPress={() => { void act(async () => {
              const value = await projects.discoveryResults(job.id, nextOffset)
              if (api.current.discoveries.find((row) => row.id === job.id)?.revision !== job.revision) return
              setCandidates((previous) => [...previous, ...value.candidates]); setNextOffset(value.nextOffset)
            }) }}>Load more candidates</Button>}
            <div className="command-project-form-actions">
              <Button variant="ghost" disabled={busy} onPress={() => { setRoot(job.requestedRoot); onSelectJob(null) }}>New scan</Button>
              {discoveryActive(job) ? <Button variant="ghost" disabled={!connected || busy} onPress={() => { void act(() => projects.cancelDiscovery(job.id)) }}>Stop discovery</Button> :
                canImport && <>
                  <Button variant="ghost" disabled={!connected || busy || !selected.size} onPress={() => { void act(() => register([...selected].sort())) }}>Add selected ({selected.size})</Button>
                  <Button disabled={!connected || busy || (discoveryFilterActive(job) && !job.filtered?.matched)}
                    onPress={() => { void act(() => register(discoveryFilterActive(job) ? 'filtered' : 'recommended')) }}>
                    {discoveryFilterActive(job) ? 'Add shown projects' : 'Add recommended projects'}</Button>
                </>}
            </div>
          </> : <p role="status">{connected ? 'Loading discovery…' : 'Reconnect to view this discovery.'}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>
}
