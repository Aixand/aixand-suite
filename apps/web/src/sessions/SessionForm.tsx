import { useContentFieldVariant } from '../branding/ContentTheme'
import { useId, useRef, useState } from 'react'
import { Button, Select, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { AgentError } from '../agents/client'
import type { Profile, SavedSession } from '../agents/client'
import type { Project } from '../projects/model'
import { PaneForm } from '../agents/AgentWorkspace'
import { providerLabel } from '../agents/presentation'
import { profileTerminalAvailable } from '../agents/backends'
import { requestId } from '../terminals/connection'

export function SessionForm({ agents: a, projects, initialProfile, initialCwd, initialModel, inline = true, session, customize = false, onClose, navigate }: {
  agents: AgentsModel; projects: Project[]; initialProfile?: Profile; initialCwd?: string; session?: SavedSession; customize?: boolean
  initialModel?: string; inline?: boolean
  onClose: () => void; navigate: (route: string) => void
}) {
  const fieldVariant = useContentFieldVariant()
  const profiles = a.catalog?.profiles ?? []
  const eligible = session ? profiles.filter(item => item.provider === session.provider &&
    (session.environmentId ? item.environment_id === session.environmentId || session.canContinue : item.profile === session.profile || session.canContinue)) : profiles
  const [profileId, setProfileId] = useState(initialProfile?.id ??
    (session ? eligible.find(item => session.environmentId ? item.environment_id === session.environmentId : item.profile === session.profile)?.id ?? eligible[0]?.id :
      (profiles.find(item => item.preferred) ?? profiles[0])?.id) ?? '')
  const profile = profiles.find(item => item.id === profileId)
  const [cwd, setCwd] = useState(session?.cwd ?? initialCwd ?? a.catalog?.cwd ?? '')
  const [projectId, setProjectId] = useState(projects.find(project => project.path === cwd)?.id ?? '')
  const [model, setModel] = useState(initialModel ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const attempt = useRef<{ signature: string; key: string } | null>(null)
  const pending = useRef(false)
  const formId = useId()
  const continuation = Boolean(session && profile && (session.environmentId ? profile.environment_id !== session.environmentId : profile.profile !== session.profile))
  const terminalReady = profile && profileTerminalAvailable(a.catalog, profile)
  const disabled = busy || a.status !== 'connected'
  async function start() {
    if (!profile || pending.current || disabled || uncertain) return
    pending.current = true; setBusy(true); setError('')
    try {
      const settings = { provider: profile.provider, profile: profile.profile, expectedAuth: null,
        ...(profile.environment_id ? { environmentId: profile.environment_id } : {}),
        ...(profile.profile_id ? { profileId: profile.profile_id } : {}),
        ...(profile.revision ? { expectedRevision: profile.revision } : {}),
        ...(profile.environment_revision ? { expectedEnvironmentRevision: profile.environment_revision } : {}),
        ...(session ? { id: session.id, sourceProfile: session.profile } : { cwd: cwd.trim(), ...(projectId ? { projectId } : {}) }),
        ...(model.trim() ? { model: model.trim() } : {}) }
      const signature = JSON.stringify(settings)
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: requestId() }
      const result = await a.request<{ session_id: string }>('session-start', { key: attempt.current.key, ...settings })
      if (!result.session_id) throw new Error('The terminal launch is unconfirmed. Check Terminals before starting another.')
      await a.refresh(); void a.refreshSessions()
      navigate(`terminals/${encodeURIComponent(result.session_id)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Session launch failed.')
      if (cause instanceof AgentError && (cause.runId || cause.uncertain || ['timeout', 'connection_lost', 'bridge_lost'].includes(cause.code ?? '')) || /unconfirmed|uncertain/i.test(String(cause))) setUncertain(true)
    } finally { pending.current = false; setBusy(false) }
  }
  return <PaneForm inline={inline} open title={session ? 'Continue session' : 'Open terminal'}
    description={session?.title} onOpenChange={open => { if (!open && !busy) onClose() }} trigger={<Button hidden>Session settings</Button>}
    footer={<><Button variant="ghost" disabled={busy} onPress={onClose}>Cancel</Button>
      <Button form={formId} type="submit" loading={busy} disabled={disabled || !profile || !terminalReady || !cwd.trim() || uncertain || Boolean(session?.archived) || session?.canResume === false}>
        {continuation ? 'Continue in selected profile' : session ? 'Resume session' : 'Open terminal'}</Button></>}>
    <form id={formId} className="agents-sheet-form" onSubmit={event => { event.preventDefault(); void start() }}>
      {error && <p className="agents-error" role="alert">{error}</p>}
      {uncertain && <Button variant="secondary" onPress={() => navigate('terminals')}>Inspect Terminals</Button>}
      <Select label="Agent profile" variant={fieldVariant} value={profileId} disabled={disabled || Boolean(session && !customize)}
        options={eligible.map(item => ({ id: item.id, label: `${item.profile} · ${providerLabel(item.provider)}` }))}
        onChange={value => { setProfileId(value); setModel('') }} />
      <p>This terminal uses the selected profile's native login, tools, and instructions.</p>
      {session ? <p className="ws-note">Project: {session.cwd}</p> : <>
        {Boolean(projects.length) && <Select label="Project" variant={fieldVariant} value={projectId} disabled={disabled}
          options={[...projects.map(project => ({ id: project.id, label: project.name, description: project.path })), { id: '', label: 'Enter a directory manually' }]}
          onChange={value => { setProjectId(value); const project = projects.find(item => item.id === value); if (project) setCwd(project.path) }} />}
        <TextField label="Project directory" variant={fieldVariant} required value={cwd} disabled={disabled} onChange={event => { setCwd(event.target.value); setProjectId('') }} />
      </>}
      {continuation && <p className="ws-note">Agent Manager will continue this session in {profile?.profile}. It will use the provider's native continuation method.</p>}
      {session?.archived && <p className="ws-note">This session is archived. Restore it in the provider before you resume it.</p>}
      {profile && !terminalReady && profile.readiness?.terminal?.reason && <p className="agents-error">{profile.readiness.terminal.reason}</p>}
      <TextField label="Model override" variant={fieldVariant} value={model} disabled={disabled} onChange={event => setModel(event.target.value)} />
      <p className="ws-note">Opens in Terminals after launch.</p>
    </form>
  </PaneForm>
}
