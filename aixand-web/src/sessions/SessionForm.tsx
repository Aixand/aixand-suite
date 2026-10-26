import { profileAccountLabel, accountStatusLabel } from '../agents/accountPresentation'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useId, useRef, useState } from 'react'
import { Accordion, Button, DescriptionList, Select, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { AgentError } from '../agents/client'
import type { Profile, SavedSession } from '../agents/client'
import type { Project } from '../projects/model'
import { PaneForm } from '../agents/AgentWorkspace'
import { McpPicker } from '../agents/mcp'
import type { McpPolicy } from '../agents/mcp'
import { NewLoginButton } from '../agents/SavedLogins'
import { providerLabel } from '../agents/presentation'
import { requestId } from '../terminals/connection'

export function SessionForm({ agents: a, projects, initialProfile, initialCwd, session, customize = false, onClose, navigate }: {
  agents: AgentsModel; projects: Project[]; initialProfile?: Profile; initialCwd?: string; session?: SavedSession; customize?: boolean
  onClose: () => void; navigate: (route: string) => void
}) {
  const fieldVariant = useContentFieldVariant()
  const profiles = a.catalog?.profiles ?? []
  const [profileId, setProfileId] = useState(initialProfile?.id ?? (session ? `${session.provider}/${session.profile}` : profiles[0]?.id) ?? '')
  const profile = profiles.find((item) => item.id === profileId)
  const [auth, setAuth] = useState(profile?.auth ?? '')
  const [cwd, setCwd] = useState(session?.cwd ?? initialCwd ?? a.catalog?.cwd ?? '')
  const [projectId, setProjectId] = useState(projects.find((project) => project.path === cwd)?.id ?? '')
  const [model, setModel] = useState('')
  const [mcp, setMcp] = useState<McpPolicy | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const attempt = useRef<{ signature: string; key: string } | null>(null)
  const pending = useRef(false)
  const formId = useId()
  const continuation = session && profileId !== `${session.provider}/${session.profile}`
  const changedLogin = profile && auth && auth !== profile.auth
  const capability = a.catalog?.capabilities.find((item) => item.provider === profile?.provider)
  const native = capability?.authMode === 'native' || profile?.authMode === 'native'
  const installed = capability?.installed
  const disabled = busy || a.status !== 'connected'
  const logins = a.catalog?.auths.filter((login) => login.provider === profile?.provider) ?? []
  const eligible = session ? profiles.filter((item) => item.provider === session.provider &&
    (item.profile === session.profile || session.canContinue)) : profiles
  async function start() {
    if (!profile || pending.current || disabled || uncertain) return
    pending.current = true; setBusy(true); setError('')
    const settings = { provider: profile.provider, profile: profile.profile, expectedAuth: profile.auth,
      ...(auth ? { auth } : {}), ...(session ? { id: session.id, sourceProfile: session.profile } : { cwd: cwd.trim() }),
      ...(model.trim() ? { model: model.trim() } : {}), ...(mcp ? { mcp } : {}) }
    const signature = JSON.stringify(settings)
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: requestId() }
    try {
      const result = await a.request<{ session_id: string }>('session-start', { key: attempt.current.key, ...settings })
      await a.refresh(); void a.refreshSessions()
      navigate(`terminals/${encodeURIComponent(result.session_id)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session launch failed.')
      if (cause instanceof AgentError && (cause.runId || ['timeout', 'connection_lost', 'bridge_lost'].includes(cause.code ?? '')) || /unconfirmed|uncertain/i.test(String(cause))) setUncertain(true)
    } finally { pending.current = false; setBusy(false) }
  }
  return <PaneForm inline open title={session ? 'Continue session' : 'New session'}
    description={session?.title} onOpenChange={(open) => { if (!open && !busy) onClose() }} trigger={<Button hidden>Session settings</Button>}
    footer={<><Button variant="ghost" disabled={busy} onPress={onClose}>Cancel</Button>
      <Button form={formId} type="submit" loading={busy} disabled={disabled || !profile || !installed || !cwd.trim() || uncertain || !!session?.archived && !continuation}>
        {continuation ? 'Create continuation' : session ? changedLogin ? 'Change login and resume' : 'Resume session' : 'Start session'}</Button></>}>
    <form id={formId} className="agents-sheet-form" onSubmit={(event) => { event.preventDefault(); void start() }}>
      {error && <p className="agents-error" role="alert">{error}</p>}
      {uncertain && <Button variant="secondary" onPress={() => navigate('terminals')}>Inspect Terminals</Button>}
      <Select label="Agent profile" variant={fieldVariant} value={profileId} disabled={disabled || !!session && !customize}
        options={eligible.map((item) => ({ id: item.id, label: `${item.profile} · ${providerLabel(item.provider)}` }))}
        onChange={(value) => { setProfileId(value); setAuth(profiles.find((item) => item.id === value)?.auth ?? ''); setMcp(undefined); setModel('') }} />
      {native && profile ? <p>{profileAccountLabel(profile)} · {accountStatusLabel(profile.authentication?.terminal)}</p> : <>
      <Select label="Saved login" variant={fieldVariant} value={auth} disabled={disabled || !!session && !customize}
        options={[...(!profile?.auth ? [{ id: '', label: profile?.provider === 'opencode' ? 'Provider configuration' : 'No saved account selected' }] : []), ...logins.map((item) => ({ id: item.auth, label: item.auth }))]} onChange={setAuth} />
      {profile && (!session || customize) && <NewLoginButton agents={a} provider={profile.provider} navigate={navigate} disabled={disabled} onCreated={setAuth} />}
      </>}
      {changedLogin && <p className="ws-note">This changes {profile.profile}'s assigned login from {profile.auth ?? 'unassigned'} to {auth}. Future sessions in this profile will use {auth}. Active agents must finish before its login can change.</p>}
      {session ? <p className="ws-note">Project: {session.cwd}</p> : <>
        {!!projects.length && <Select label="Project" variant={fieldVariant} value={projectId} disabled={disabled}
          options={[...projects.map((project) => ({ id: project.id, label: project.name, description: project.path })), { id: '', label: 'Enter a directory manually' }]}
          onChange={(value) => { setProjectId(value); const project = projects.find((item) => item.id === value); if (project) setCwd(project.path) }} />}
        <TextField label="Project directory" variant={fieldVariant} required value={cwd} disabled={disabled} onChange={(event) => { setCwd(event.target.value); setProjectId('') }} />
      </>}
      {continuation && <p className="ws-note">Creates a linked conversation in {profile?.profile}'s home, carrying supported context from this session and using the selected profile's settings and tools.</p>}
      {session?.archived && !continuation && <p className="ws-note">This session is archived. Choose another profile to create a continuation.</p>}
      {profile && <DescriptionList items={[{ id: 'model', label: 'Model', value: model.trim() || profile.model || 'Profile default' },
        { id: 'tools', label: 'Tools', value: session && !continuation ? 'Saved session tools' : mcp ? 'Customized for this session' : profile.mcp?.servers.join(', ') || 'No tools attached' }]} />}
      {(!session || continuation) && <Accordion items={[{ id: 'customize', title: 'Customize this session', content: <div className="agents-sheet-form">
        <TextField label="Model override" variant={fieldVariant} value={model} disabled={disabled} onChange={(event) => setModel(event.target.value)} />
        {profile && <McpPicker agents={a} provider={profile.provider} profile={profile.profile} cwd={cwd} value={mcp} onChange={setMcp} disabled={disabled} />}
      </div> }]} />}
      {!installed && profile && <p className="agents-error">Install {providerLabel(profile.provider)} in Agents / Providers before starting.</p>}
      <p className="ws-note">Opens in Terminals after launch.</p>
    </form>
  </PaneForm>
}
