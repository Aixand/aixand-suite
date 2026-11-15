import { workspaceFetch } from '../auth/transport'
import { Button, SettingsSection, Switch } from 'bbb-design'
import { useEffect, useState } from 'react'
import { authRequest } from '../auth/client'

type Component = { availableVersion?: string; action?: string; version: string | null; name?: string; scope?: string; updatable?: boolean; reason?: string | null; requires?: Record<string, string> }
type Update = { available: boolean; message?: string; error?: string | null; daily?: boolean; automaticDownload?: boolean; checkedAt?: number | null;
  phase?: string; requested?: string[]; candidates?: Record<string, Component>; updateAvailable?: boolean;
  installed?: { version: string; role: string }; release?: { version: string }; host?: { name: string }; completed?: string[]; recoveryRequired?: boolean; inventory?: { components?: Record<string, Component>; products?: Record<string, Component> } }
type Plan = { revision: string; ready: boolean; licenses: { id?: string; product?: string; text?: string; url?: string; sha256: string }[]; shared?: boolean;
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
function UpdateGroup({ products = false, application = false }: { products?: boolean; application?: boolean }) {
  const suffix = application ? '/application' : products ? '/products' : ''
  const selectionKey = products ? 'products' : 'components'
  const [value, setValue] = useState<Update | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null), [consent, setConsent] = useState(false)
  const [selected, setSelected] = useState<string[] | null>(null), [restart, setRestart] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => { void request<Update>('GET', undefined, suffix).then(value => { if (alive) { setValue(value); setConnectionError('') } }).catch(error => { if (alive) setConnectionError(String(error.message)) }) }
    load(); const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [suffix])
  async function action(input: object) {
    const previous = value
    setBusy(true); setError('')
    try { await request('POST', input, suffix); setValue(await request<Update>('GET', undefined, suffix)); setPlan(null); setConsent(false) }
    catch (error) { setValue(previous); setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function review() {
    setBusy(true); setError(''); setConsent(false); setRestart(false)
    try { setPlan(await request<Plan>('POST', { action: 'plan', ...(!application && selected ? { [selectionKey]: selected } : {}) }, suffix)) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const candidateIds = application ? value?.updateAvailable ? ['server'] : [] : Object.keys(value?.candidates || {})
  const choices = candidateIds.length ? candidateIds : value?.requested || []
  const working = busy || value?.recoveryRequired === true || ['downloading', 'preparing', 'installing', 'restarting'].includes(value?.phase || '')
  const installed: Record<string, Component> = application ? value?.installed ? { server: { name: value.installed.role === 'desktop' ? 'Desktop application' : 'Server application', version: value.installed.version } } : {} : (products ? value?.inventory?.products : value?.inventory?.components) || {}
  const name = (id: string) => installed[id]?.name || id
  return <SettingsSection title={application ? 'Application updates' : products ? 'Installed tool updates' : 'Workspace host updates'} headingLevel={2}>
    <div className="settings-update-summary">
      <p>{application ? 'Update the whole installed application. Desktop and Client application updates use the trusted connection window on their own computer.' : products ? 'Update individual tools on the workspace host, including Manager Suite tools, Runner and MCP. Shared tools may also be used by other applications on that computer.' : 'Choose updates for the components hosting this workspace. Companion updates are included in your review. Desktop application updates are in the connection window.'}</p>
      {value?.host && <p>Computer: {value.host.name}</p>}
      <div className="settings-update-inventory"><table><caption>{application ? 'Installed application' : products ? 'Installed tools on this computer' : 'Installed workspace components'}</caption><thead><tr><th scope="col">{products ? 'Tool' : 'Component'}</th><th scope="col">Installed</th><th scope="col">Available</th>{products && <th scope="col">Installation</th>}</tr></thead><tbody>
        {Object.entries(installed).map(([id, item]) => <tr key={id}><th scope="row">{name(id)}</th><td>{item.version || 'Not managed here'}</td><td>{(application ? value?.updateAvailable ? value.release?.version : undefined : value?.candidates?.[id]?.version || item.availableVersion) || '—'}</td>{products && <td>{item.reason || (item.scope === 'shared' ? 'Shared with other applications' : 'Private to this workspace')}</td>}</tr>)}
      </tbody></table></div>
      <p role="status">{value?.message || (value ? 'Choose components or check for updates.' : 'Checking the installed update service…')}</p>
      {Boolean(value?.completed?.length) && <p>Updated: {value!.completed!.map(name).join(', ')}</p>}
      {value?.recoveryRequired && <p>Installation needs recovery. Completed tool updates are retained; further installation is blocked until the recorded operation is resolved.</p>}
      {value?.checkedAt && <p>Last checked: {new Date(value.checkedAt).toLocaleString()}</p>}
    </div>
    <div className="settings-switch-row">
    <Switch label={application ? 'Check application updates daily' : products ? 'Check tool updates daily' : 'Check for updates daily'} description="Check while this workspace is running. Updates are installed only when you choose."
      checked={value?.daily !== false} disabled={!value?.available || working}
      onChange={event => { const daily = event.target.checked; setValue(current => current ? { ...current, daily } : current); void action({ action: 'settings', daily }) }} />
    </div>
    {!application && <Switch label={products ? 'Download tool updates automatically' : 'Download updates automatically'} description="Download verified updates after checks. Installation always needs your approval."
      checked={value?.automaticDownload === true} disabled={!value?.available || working}
      onChange={event => void action({ action: 'settings', automaticDownload: event.target.checked })} />}
    {!application && <fieldset disabled={working}><legend>{products ? 'Tools to update' : 'Components to update'}</legend>
      {choices.map(id => <label key={id}><input type="checkbox"
        checked={(selected || value?.requested || Object.keys(value?.candidates || {})).includes(id)} onChange={event => {
          const current = selected || value?.requested || Object.keys(value?.candidates || {});
          setSelected(event.target.checked ? [...current, id] : current.filter(item => item !== id)); setPlan(null); setConsent(false)
        }} />{name(id)}</label>)}
    </fieldset>}
    <div className="settings-update-actions">
      {!application && <Button variant="ghost" disabled={working || choices.length === 0} onPress={() => { setSelected(choices); setPlan(null); setConsent(false) }}>Select all compatible {products ? 'tools' : 'components'}</Button>}
      <Button disabled={!value?.available || working} onPress={() => { setSelected(null); void action({ action: 'check' }) }}>{application ? 'Check application updates' : products ? 'Check for tool updates' : 'Check for updates'}</Button>
      <Button disabled={!value?.available || working || choices.length === 0 || selected?.length === 0} onPress={() => void review()}>{application ? 'Review application update' : products ? 'Review tool updates' : 'Review update'}</Button>
    </div>
    {plan && <div className="settings-update-plan" role="region" aria-label={application ? 'Review application update' : products ? 'Review tool updates' : 'Review server update'}>
      <p>{plan.restartRequired ? 'Installing restarts this workspace. Finish active work first.' : 'No workspace restart is required.'} Account logins, settings and saved history are kept.</p>
      {Object.entries(plan.candidates).map(([id, item]) => <p key={id}>{name(id)}: {item.version}{item.action === 'adopt' ? ' (use the verified version already installed)' : ''}{!plan.requested.includes(id) ? ' (companion update)' : ''}</p>)}
      {plan.blockers.map((row, index) => <p key={index}>{[row.name, row.reason].filter(Boolean).join(': ') || 'Active work must finish before installing.'}</p>)}
      {plan.unsupported.map(row => <p key={row.id}>{row.id}: {row.action}</p>)}
      {plan.shared && <p>These changes apply to shared tools used by other applications. Other active consumers may block installation.</p>}
      {plan.licenses.map(row => <details key={row.sha256}><summary>{row.id || row.product} license</summary>{row.url && <a href={row.url} target="_blank" rel="noreferrer">Read license</a>}{row.text && <pre className="settings-update-license">{row.text}</pre>}</details>)}
      <Button disabled={working || plan.unsupported.length > 0 || !Object.keys(plan.candidates).length}
        onPress={() => void action({ action: 'download', ...(!application ? { [selectionKey]: plan.requested } : {}) })}>{application ? 'Download application update' : products ? 'Download selected tool updates' : 'Download selected updates'}</Button>
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
  const [checking, setChecking] = useState(false), [error, setError] = useState('')
  async function checkAll() {
    setChecking(true); setError('')
    try { await request('POST', { action: 'check' }, '/check-all') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setChecking(false) }
  }
  return <><div className="settings-update-actions"><Button disabled={checking} onPress={() => void checkAll()}>Check all updates</Button></div>
    {error && <p role="alert">{error}</p>}<UpdateGroup application /><UpdateGroup /><UpdateGroup products /></>
}
