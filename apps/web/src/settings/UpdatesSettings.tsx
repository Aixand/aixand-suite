import { workspaceFetch } from '../auth/transport'
import { Button, SettingsSection, Switch } from 'bbb-design'
import { useEffect, useState } from 'react'
import { authRequest } from '../auth/client'

type Component = { version: string; requires?: Record<string, string> }
type Update = { available: boolean; message?: string; error?: string | null; daily?: boolean; automaticDownload?: boolean; checkedAt?: number | null;
  phase?: string; requested?: string[]; candidates?: Record<string, Component>; updateAvailable?: boolean;
  inventory?: { components: Record<string, Component> } }
type Plan = { revision: string; ready: boolean; licenses: { id: string; url: string; sha256: string }[];
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
export function UpdatesSettings() {
  const [value, setValue] = useState<Update | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null), [consent, setConsent] = useState(false)
  const [selected, setSelected] = useState<string[] | null>(null), [restart, setRestart] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => { void request<Update>().then(value => { if (alive) setValue(value) }).catch(error => { if (alive) setError(String(error.message)) }) }
    load(); const timer = setInterval(load, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  async function action(input: object) {
    const previous = value
    setBusy(true); setError('')
    try { await request('POST', input); setValue(await request<Update>()); setPlan(null); setConsent(false) }
    catch (error) { setValue(previous); setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function review() {
    setBusy(true); setError(''); setConsent(false); setRestart(false)
    try { setPlan(await request<Plan>('POST', { action: 'plan', ...(selected ? { components: selected } : {}) })) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const candidateIds = Object.keys(value?.candidates || {})
  const choices = candidateIds.length ? candidateIds : value?.requested || []
  const working = busy || ['downloading', 'preparing', 'installing', 'restarting'].includes(value?.phase || '')
  return <SettingsSection title="Workspace host updates" headingLevel={2}>
    <div className="settings-update-summary">
      <p>Choose updates for the components hosting this workspace. Companion updates are included in your review. Desktop application updates are in the connection window.</p>
      {Object.entries(value?.inventory?.components || {}).map(([id, item]) => <p key={id}>{id}: {item.version}</p>)}
      <p role="status">{value?.message || (value ? 'Choose components or check for updates.' : 'Checking the installed update service…')}</p>
      {value?.checkedAt && <p>Last checked: {new Date(value.checkedAt).toLocaleString()}</p>}
    </div>
    <div className="settings-switch-row">
    <Switch label="Check for updates daily" description="Check while this server is running. Updates are installed only when you choose."
      checked={value?.daily !== false} disabled={!value?.available || working}
      onChange={event => { const daily = event.target.checked; setValue(current => current ? { ...current, daily } : current); void action({ action: 'settings', daily }) }} />
    </div>
    <Switch label="Download updates automatically" description="Download verified updates after checks. Installation always needs your approval."
      checked={value?.automaticDownload === true} disabled={!value?.available || working}
      onChange={event => void action({ action: 'settings', automaticDownload: event.target.checked })} />
    <fieldset disabled={working}><legend>Components to update</legend>
      {choices.map(id => <label key={id}><input type="checkbox"
        checked={(selected || value?.requested || Object.keys(value?.candidates || {})).includes(id)} onChange={event => {
          const current = selected || value?.requested || Object.keys(value?.candidates || {});
          setSelected(event.target.checked ? [...current, id] : current.filter(item => item !== id)); setPlan(null); setConsent(false)
        }} />{id}</label>)}
    </fieldset>
    <div className="settings-update-actions">
      <Button disabled={!value?.available || working} onPress={() => { setSelected(null); void action({ action: 'check' }) }}>Check for updates</Button>
      <Button disabled={!value?.available || working || choices.length === 0 || selected?.length === 0} onPress={() => void review()}>Review update</Button>
    </div>
    {plan && <div className="settings-update-plan" role="region" aria-label="Review server update">
      <p>{plan.restartRequired ? 'Installing restarts this workspace. Finish active work first.' : 'No workspace restart is required.'} Account logins, settings and saved history are kept.</p>
      {Object.entries(plan.candidates).map(([id, item]) => <p key={id}>{id}: {item.version}{!plan.requested.includes(id) ? ' (companion update)' : ''}</p>)}
      {plan.blockers.map((row, index) => <p key={index}>{row.name || row.reason || 'Active work must finish before installing.'}</p>)}
      {plan.unsupported.map(row => <p key={row.id}>{row.id}: {row.action}</p>)}
      {plan.licenses.map(row => <p key={row.sha256}><a href={row.url} target="_blank" rel="noreferrer">{row.id} license</a></p>)}
      <Button disabled={working || plan.unsupported.length > 0 || !Object.keys(plan.candidates).length}
        onPress={() => void action({ action: 'download', components: plan.requested })}>Download selected updates</Button>
      <Switch label="I agree to the displayed licenses and companion updates" checked={consent} onChange={event => setConsent(event.target.checked)} />
      <Switch label="I approve the reviewed restart impact" checked={restart} onChange={event => setRestart(event.target.checked)} />
      <Button disabled={!plan.ready || !consent || !restart || working || plan.blockers.length > 0 || plan.unsupported.length > 0 || value?.phase !== 'downloaded'}
        onPress={() => void action({ action: 'install', confirmed: true, revision: plan.revision, acceptedLicenses: plan.licenses.map(row => row.sha256), restartConsent: true })}>Install and restart server</Button>
      <Button variant="ghost" onPress={() => setPlan(null)}>Cancel</Button>
    </div>}
    {(error || value?.error) && <p role="alert">{error || value?.error}</p>}
  </SettingsSection>
}
