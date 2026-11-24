import { workspaceFetch } from '../auth/transport'
import { Button, SettingsSection, Switch } from 'bbb-design'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { authRequest } from '../auth/client'

type Component = { release?: string; bundledVersion?: string | null; canReviewRestore?: boolean; availableVersion?: string; action?: string; version: string | null; name?: string; scope?: string; updatable?: boolean; reason?: string | null; requires?: Record<string, string> }
type Update = { available: boolean; message?: string; error?: string | null; daily?: boolean; automaticDownload?: boolean; checkedAt?: number | null;
  phase?: string; requested?: string[]; versions?: Record<string, { version: string; release: string; selectable: boolean; qualified: boolean }[]>; candidates?: Record<string, Component>; updateAvailable?: boolean;
  installed?: { version: string; role: string }; release?: { version: string }; host?: { name: string }; completed?: string[]; recoveryRequired?: boolean; inventory?: { components?: Record<string, Component>; products?: Record<string, Component> } }
type RestoreReview = { ready: boolean; revision: string; restartRequired: boolean; licenses: Plan['licenses']; candidates: Record<string, Component>; blockers: { name?: string; reason?: string }[] }
type Plan = { selectedReleases?: Record<string, string>; revision: string; ready: boolean; licenses: { id?: string; product?: string; text?: string; url?: string; sha256: string }[]; shared?: boolean;
  candidates: Record<string, Component>; requested: string[]; blockers: { name?: string; reason?: string }[];
  unsupported: { id: string; action: string }[]; restartRequired: boolean }
async function request<T>(method: 'GET' | 'POST' = 'GET', body?: unknown, suffix = ''): Promise<T> {
  const session = body ? await authRequest<{ csrfToken: string }>('session') : null
  const options: RequestInit = { method, credentials: 'same-origin', cache: 'no-store' }
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session!.csrfToken }
    options.body = JSON.stringify(body)
  }
  const response = await workspaceFetch('/api/updates' + suffix, options)
  const value = await response.json()
  if (!response.ok) throw new Error(value.message || 'The update request failed.')
  return value as T
}
type GroupSummary = { count: number; checkedAt?: number | null; unavailable: boolean; working: boolean; failed: boolean; loaded: boolean }
function UpdateGroup({ products = false, application = false, preferences, onSummary }: {
  products?: boolean; application?: boolean; preferences: HTMLDivElement | null;
  onSummary: (key: string, summary: GroupSummary) => void;
}) {
  const suffix = application ? '/application' : products ? '/products' : ''
  const selectionKey = products ? 'products' : 'components'
  const [value, setValue] = useState<Update | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null), [consent, setConsent] = useState(false)
  const [restoreReview, setRestoreReview] = useState<RestoreReview | null>(null)
  const [selectedReleases, setSelectedReleases] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string[] | null>(null), [restart, setRestart] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => { void request<Update>('GET', undefined, suffix).then(value => { if (alive) { setValue(value); setConnectionError('') } }).catch(error => { if (alive) setConnectionError(String(error.message)) }) }
    load(); const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [suffix])
  async function action(input: object) {
    const previous = value
    setBusy(true); setError(''); setRestoreReview(null)
    try { await request('POST', input, suffix); setValue(await request<Update>('GET', undefined, suffix)); setPlan(null); setConsent(false) }
    catch (error) { setValue(previous); setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function review() {
    setBusy(true); setError(''); setConsent(false); setRestart(false)
    const ids = selected || value?.requested || candidateIds
    const selection = products && Object.keys(value?.versions || {}).length
      ? { releases: Object.fromEntries(ids.map(id => [id, selectedReleases[id] || value?.candidates?.[id]?.release])) }
      : !application && selected ? { [selectionKey]: selected } : {}
    try { setPlan(await request<Plan>('POST', { action: 'plan', ...selection }, suffix)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function reviewRestore() {
    setBusy(true); setError(''); setPlan(null); setRestoreReview(null); setConsent(false); setRestart(false)
    try { setRestoreReview(await request<RestoreReview>('POST', { action: 'restore-plan' }, suffix)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const candidateIds = application ? value?.updateAvailable ? ['server'] : [] : Object.keys(value?.candidates || {})
  const choices = candidateIds.length ? candidateIds : value?.requested || []
  const working = busy || value?.recoveryRequired === true || ['downloading', 'preparing', 'installing', 'restarting'].includes(value?.phase || '')
  const installed: Record<string, Component> = application ? value?.installed ? { server: { name: value.installed.role === 'desktop' ? 'Desktop application' : 'Server application', version: value.installed.version } } : {} : (products ? value?.inventory?.products : value?.inventory?.components) || {}
  const name = (id: string) => installed[id]?.name || id
  useEffect(() => {
    onSummary(suffix, { count: candidateIds.length, checkedAt: value?.checkedAt, unavailable: !value?.available,
      working, loaded: Boolean(value || connectionError), failed: Boolean(error || connectionError || value?.error || value?.recoveryRequired) })
  }, [suffix, candidateIds.length, value?.checkedAt, value?.available, value?.error, value?.recoveryRequired, working, error, connectionError, onSummary])
  const status = !value ? 'Connecting' : value.recoveryRequired ? 'Recovery required' : working ? 'In progress' : !value.available ? 'Unavailable' : candidateIds.length ? `${candidateIds.length} available` : value.checkedAt ? 'Up to date' : 'Not checked';
  return <SettingsSection className="settings-update-group" title={application ? 'Application updates' : products ? 'Installed tool updates' : 'Workspace host updates'} headingLevel={2}>
    <div className="settings-update-summary">
      <span className="settings-update-badge" data-attention={candidateIds.length > 0 || undefined}>{status}</span>
      <p>{application ? 'Update the whole installed application. Desktop and Client application updates use the trusted connection window on their own computer.' : products ? 'Update individual tools on the workspace host, including Manager Suite tools, Runner and MCP. Shared tools may also be used by other applications on that computer.' : 'Choose updates for the components hosting this workspace. Companion updates are included in your review. Desktop application updates are in the connection window.'}</p>
      {value?.host && <p>Computer: {value.host.name}</p>}
      <div className="settings-update-inventory"><table><caption className="settings-update-sr-only">{application ? 'Installed application' : products ? 'Installed tools on this computer' : 'Installed workspace components'}</caption><thead><tr><th scope="col">{products ? 'Tool' : 'Component'}</th><th scope="col">Installed</th><th scope="col">Available</th></tr></thead><tbody>
        {Object.entries(installed).map(([id, item]) => <tr key={id}><th scope="row">
          {!application && choices.includes(id) ? <label className="settings-update-choice"><input type="checkbox" disabled={working}
            checked={(selected || value?.requested || candidateIds).includes(id)} onChange={event => {
              const current = selected || value?.requested || candidateIds;
              setSelected(event.target.checked ? [...current, id] : current.filter(item => item !== id)); setPlan(null); setConsent(false)
            }} />{name(id)}</label> : name(id)}
          {products && <span className="settings-update-item-note">{item.reason || (item.scope === 'shared' ? 'Shared with other applications' : 'Private to this workspace')}</span>}
        </th><td data-label="Installed">{item.version || 'Not managed here'}
          {products && item.bundledVersion && <span className="settings-update-item-note">Bundled {item.bundledVersion}</span>}
        </td><td data-label="Available">{products && value?.versions?.[id]?.length ? <select aria-label={`Available versions for ${name(id)}`}
          disabled={working || !value.candidates?.[id]} value={selectedReleases[id] || value.candidates?.[id]?.release || ''}
          onChange={event => { setSelectedReleases(current => ({ ...current, [id]: event.target.value })); setPlan(null); setConsent(false) }}>
          {!value.candidates?.[id] && <option value="">No eligible update</option>}
          {value.versions[id].map(version => <option key={version.release} value={version.release} disabled={!version.selectable}>
            {version.version}{!version.qualified ? ' (unverified for this build)' : !version.selectable ? ' (unavailable for update)' : ''}
          </option>)}
        </select> : (application ? value?.updateAvailable ? value.release?.version : undefined : value?.candidates?.[id]?.version || item.availableVersion) || '—'}</td></tr>)}
        {!Object.keys(installed).length && <tr><td colSpan={3} className="settings-update-empty">{value ? 'No managed items reported on this computer.' : 'Loading installed versions…'}</td></tr>}
      </tbody></table></div>
      <p role="status">{value?.message || (value ? 'Choose components or check for updates.' : 'Checking the installed update service…')}</p>
      {Boolean(value?.completed?.length) && <p>Updated: {value!.completed!.map(name).join(', ')}</p>}
      {value?.recoveryRequired && <p>Installation needs recovery. Completed tool updates are retained; further installation is blocked until the recorded operation is resolved.</p>}
      {value?.checkedAt && <p>Last checked: {new Date(value.checkedAt).toLocaleString()}</p>}
    </div>
    {preferences && createPortal(<div className="settings-update-preference-group">
      <h3>{application ? 'Application' : products ? 'Installed tools' : 'Workspace host'}</h3>
    <div className="settings-switch-row">
    <Switch label={application ? 'Check application updates daily' : products ? 'Check tool updates daily' : 'Check for updates daily'} description="Check while this workspace is running. Updates are installed only when you choose."
      checked={value?.daily !== false} disabled={!value?.available || working}
      onChange={event => { const daily = event.target.checked; setValue(current => current ? { ...current, daily } : current); void action({ action: 'settings', daily }) }} />
    </div>
    {!application && <Switch label={products ? 'Download tool updates automatically' : 'Download updates automatically'} description="Download verified updates after checks. Installation always needs your approval."
      checked={value?.automaticDownload === true} disabled={!value?.available || working}
      onChange={event => void action({ action: 'settings', automaticDownload: event.target.checked })} />}
    </div>, preferences)}
    {!application && choices.some(id => !installed[id]) && <fieldset className="settings-update-extra-choices" disabled={working}><legend>{products ? 'Additional tools to update' : 'Additional components to update'}</legend>
      {choices.filter(id => !installed[id]).map(id => <label className="settings-update-choice" key={id}><input type="checkbox" checked={(selected || value?.requested || candidateIds).includes(id)} onChange={event => {
        const current = selected || value?.requested || candidateIds;
        setSelected(event.target.checked ? [...current, id] : current.filter(item => item !== id)); setPlan(null); setConsent(false)
      }} />{name(id)}</label>)}
    </fieldset>}
    <div className="settings-update-actions">
      {!application && choices.length > 1 && <Button variant="ghost" disabled={working} onPress={() => { setSelected(choices); setPlan(null); setConsent(false) }}>Select all compatible {products ? 'tools' : 'components'}</Button>}
      <Button variant="ghost" disabled={!value?.available || working} onPress={() => { setSelected(null); setSelectedReleases({}); void action({ action: 'check' }) }}>{application ? 'Check application updates' : products ? 'Check for tool updates' : 'Check for updates'}</Button>
      {products && Object.values(installed).some(item => item.canReviewRestore) &&
        <Button variant="ghost" disabled={working} onPress={() => void reviewRestore()}>Review bundled versions</Button>}
      {choices.length > 0 && <Button disabled={!value?.available || working || selected?.length === 0} onPress={() => void review()}>{application ? 'Review application update' : products ? 'Review tool updates' : 'Review update'}</Button>}
    </div>
    {restoreReview && <div className="settings-update-plan" role="region" aria-label="Review bundled versions">
      <h3>Bundled versions</h3>
      {Object.entries(restoreReview.candidates).map(([id, item]) => <p key={id}>{name(id)}: {installed[id]?.version} → {item.version}</p>)}
      {restoreReview.blockers.map((row, index) => <p key={index}>{[row.name, row.reason].filter(Boolean).join(': ')}</p>)}
      {restoreReview.licenses.map(row => <details key={row.sha256}><summary>{row.product} license</summary><pre className="settings-update-license">{row.text}</pre></details>)}
      {restoreReview.ready && <>
        {restoreReview.licenses.length > 0 && <Switch label="I accept the bundled tool licenses" checked={consent} onChange={event => setConsent(event.target.checked)} />}
        {restoreReview.restartRequired && <Switch label="I approve restarting this workspace" checked={restart} onChange={event => setRestart(event.target.checked)} />}
        <Button disabled={working || (restoreReview.licenses.length > 0 && !consent) || (restoreReview.restartRequired && !restart)}
          onPress={() => void action({ action: 'restore', confirmed: true, revision: restoreReview.revision,
            acceptedLicenses: restoreReview.licenses.map(row => row.sha256), restartConsent: true })}>Restore bundled versions</Button>
      </>}
      <Button variant="ghost" onPress={() => setRestoreReview(null)}>Close review</Button>
    </div>}
    {plan && <div className="settings-update-plan" role="region" aria-label={application ? 'Review application update' : products ? 'Review tool updates' : 'Review server update'}>
      <h3>Review before installing</h3>
      <p>{plan.restartRequired ? 'Installing restarts this workspace. Finish active work first.' : 'No workspace restart is required.'} Account logins, settings and saved history are kept.</p>
      {Object.entries(plan.candidates).map(([id, item]) => <p key={id}>{name(id)}: {item.version}{item.action === 'adopt' ? ' (use the verified version already installed)' : ''}{!plan.requested.includes(id) ? ' (companion update)' : ''}</p>)}
      {plan.blockers.map((row, index) => <p key={index}>{[row.name, row.reason].filter(Boolean).join(': ') || 'Active work must finish before installing.'}</p>)}
      {plan.unsupported.map(row => <p key={row.id}>{row.id}: {row.action}</p>)}
      {plan.shared && <p>These changes apply to shared tools used by other applications. Other active consumers may block installation.</p>}
      {plan.licenses.map(row => <details key={row.sha256}><summary>{row.id || row.product} license</summary>{row.url && <a href={row.url} target="_blank" rel="noreferrer">Read license</a>}{row.text && <pre className="settings-update-license">{row.text}</pre>}</details>)}
      <Button disabled={working || plan.unsupported.length > 0 || !Object.keys(plan.candidates).length}
        onPress={() => void action({ action: 'download', ...(!application ? plan.selectedReleases
          ? { releases: plan.selectedReleases }
          : { [selectionKey]: plan.requested } : {}) })}>{application ? 'Download application update' : products ? 'Download selected tool updates' : 'Download selected updates'}</Button>
      <Switch label={application ? 'I agree to the displayed application licenses and tool changes' : products ? 'I agree to the displayed tool licenses and companion updates' : 'I agree to the displayed licenses and companion updates'} checked={consent} onChange={event => setConsent(event.target.checked)} />
      <Switch label={application ? 'I approve the application restart impact' : products ? 'I approve the reviewed tool restart impact' : 'I approve the reviewed restart impact'} checked={restart} onChange={event => setRestart(event.target.checked)} />
      <Button disabled={!plan.ready || !consent || !restart || working || plan.blockers.length > 0 || plan.unsupported.length > 0 || value?.phase !== 'downloaded'}
        onPress={() => void action({ action: 'install', confirmed: true, revision: plan.revision, acceptedLicenses: plan.licenses.map(row => row.sha256), restartConsent: true })}>{application ? 'Install application update' : products ? 'Install selected tool updates' : 'Install and restart server'}</Button>
      <Button variant="ghost" onPress={() => setPlan(null)}>Cancel</Button>
    </div>}
    {(error || connectionError || value?.error) && <p role="alert">{error || connectionError || value?.error}</p>}
  </SettingsSection>
}

export function UpdatesSettings() {
  const [preferences, setPreferences] = useState<HTMLDivElement | null>(null)
  const [summaries, setSummaries] = useState<Record<string, GroupSummary>>({})
  const onSummary = useCallback((key: string, summary: GroupSummary) => setSummaries(current => ({ ...current, [key]: summary })), [])
  const groups = Object.values(summaries)
  const count = groups.reduce((total, group) => total + group.count, 0)
  const checked = groups.map(group => group.checkedAt).filter((time): time is number => Boolean(time))
  const [checking, setChecking] = useState(false), [error, setError] = useState('')
  async function checkAll() {
    setChecking(true); setError('')
    try { await request('POST', { action: 'check' }, '/check-all') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setChecking(false) }
  }
  return <div className="settings-updates">
    <header className="settings-updates-header"><div><h2>Updates</h2><p className="settings-note">Manage updates for this workspace.</p></div>
      <Button disabled={checking || groups.some(group => group.working)} onPress={() => void checkAll()}>{checking ? 'Checking…' : 'Check all updates'}</Button>
    </header>
    <div className="settings-updates-overview" role="status">
      <strong>{checking ? 'Checking for updates…' : groups.some(group => group.failed) ? 'Some updates need attention' : count ? `${count} update${count === 1 ? '' : 's'} available` : groups.length < 3 || groups.some(group => !group.loaded) ? 'Connecting to update services…' : groups.some(group => group.working) ? 'Updates in progress' : groups.every(group => group.unavailable) ? 'Updates are managed elsewhere' : checked.length ? 'No updates reported' : 'Ready to check for updates'}</strong>
      <p className="settings-note">{checked.length ? `Last checked: ${new Date(Math.min(...checked)).toLocaleString()}` : 'Check for the latest application, workspace and tool updates.'}</p>
    </div>
    {error && <p className="settings-update-error" role="alert">{error}</p>}
    <UpdateGroup application preferences={preferences} onSummary={onSummary} />
    <UpdateGroup preferences={preferences} onSummary={onSummary} />
    <UpdateGroup products preferences={preferences} onSummary={onSummary} />
    <section className="settings-update-preferences" aria-labelledby="update-preferences-title">
      <h2 id="update-preferences-title">Update preferences</h2>
      <p className="settings-note">Checks run while this workspace is running. Installation always requires your approval.</p>
      <div ref={setPreferences} />
    </section>
  </div>
}
