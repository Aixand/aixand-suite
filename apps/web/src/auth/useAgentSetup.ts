import { randomUUID } from '../uuid'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentJob, Catalog, Profile } from '../agents/client'
import type { AgentsModel } from '../agents/model'
import { useAuth } from './AuthGate'
import { createSetupProfile } from '../agents/createSetupProfile'
import {
  initialSetup, isSetupProvider, previewCatalog, previewEnvironment, previewProviders,
  type SetupProvider, type SetupSnapshot, type SetupState, type ProjectSelection,
} from './agentSetup'

export function useAgentSetup(agents: AgentsModel | undefined, preview: boolean) {
  const auth = useAuth()
  const live = useRef({ agents, auth }); live.current = { agents, auth }
  const [snapshot, setSnapshot] = useState<SetupSnapshot>(() => preview
    ? { environment: previewEnvironment('linux'), providers: previewProviders(previewEnvironment('linux')) } : { providers: [] })
  const [catalog, setCatalog] = useState<Catalog | null>(() => preview ? previewCatalog() : null)
  const [progress, setProgress] = useState<SetupState | null>(() => preview ? initialSetup() : null)
  const progressRef = useRef(progress); progressRef.current = progress
  const projectQueue = useRef<Promise<unknown>>(Promise.resolve())
  const projectDraft = useRef<ProjectSelection | undefined>(undefined)
  const [jobs, setJobs] = useState<AgentJob[]>([])
  const [loading, setLoading] = useState(!preview)
  const [detected, setDetected] = useState(preview)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState('success')
  const connected = preview || agents?.status === 'connected'
  const mounted = useRef(true)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const refreshVersion = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; refreshVersion.current++; timers.current.forEach(clearTimeout) }
  }, [])

  const detect = useCallback(async () => {
    if (preview) return
    const a = live.current.agents!
    const version = ++refreshVersion.current
    setLoading(true)
    setError('')
    try {
      const [providers, catalog] = await Promise.all([
        a.request<SetupSnapshot>('providers'), a.request<Catalog>('catalog'),
      ])
      if (!mounted.current || version !== refreshVersion.current) return
      setSnapshot({ ...providers, providers: providers.providers.filter(row => isSetupProvider(row.provider)) }); setCatalog(catalog); setDetected(true); setError('')
    } catch (cause) {
      if (mounted.current && version === refreshVersion.current) setError(cause instanceof Error ? cause.message : 'Could not check this machine.')
      throw cause
    } finally { if (mounted.current && version === refreshVersion.current) setLoading(false) }
  }, [preview])
  const reload = useCallback(async () => {
    if (preview) return
    setLoading(true); setError('')
    try {
      const saved = await live.current.auth.reconcileOnboarding()
      if (mounted.current) { progressRef.current = saved; setProgress(saved) }
      if (saved?.status === 'complete') { if (mounted.current) setLoading(false); return }
      await detect()
    } catch (cause) {
      if (mounted.current) { setLoading(false); setError(cause instanceof Error ? cause.message : 'Could not load agent setup.') }
    }
  }, [preview, detect])
  useEffect(() => { if (connected) void reload() }, [connected, reload])
  const completed = (agents?.operations ?? []).filter(job => ['succeeded', 'failed', 'cancelled'].includes(job.status))
    .map(job => `${job.id}:${job.updatedAt}`).join(',')
  useEffect(() => { if (connected && !preview && completed) void detect().catch(() => {}) }, [connected, preview, completed, detect])
  // Keep account metadata current while the manager observes a login finishing.
  useEffect(() => { if (!preview && agents?.catalog) setCatalog(agents.catalog) }, [preview, agents?.catalog])

  async function save(next: SetupState) {
    const { revision, ...value } = next
    const saved = preview ? { ...value, revision: revision + 1 } : await live.current.auth.saveOnboarding(value, revision)
    progressRef.current = saved
    if (mounted.current) setProgress(saved)
    return saved
  }
  function saveProjects(projects: ProjectSelection) {
    const task = projectQueue.current.catch(() => {}).then(() => {
      const current = progressRef.current
      if (!current) throw new Error('Setup is still loading.')
      return save({ ...current, projects })
    })
    projectQueue.current = task
    return task
  }
  function previewOS(os: string) {
    const environment = previewEnvironment(os)
    setSnapshot(previous => ({ environment, providers: previewProviders(environment).map(info => {
      const existing = previous.providers.find(row => row.provider === info.provider)
      return existing ? { ...info, installed: existing.installed, usable: existing.usable, version: existing.version,
        sdkInstallations: existing.sdkInstallations } : info
    }) }))
  }
  function finishPreview(job: AgentJob) {
    const failed = outcome === 'failure'
    const installing = ['install', 'install-sdk', 'setup-command'].includes(job.kind)
    const finished: AgentJob = { ...job, status: failed ? 'failed' : 'succeeded', updatedAt: Date.now(),
      ...(installing && !failed ? { progress: { schema: 'agent-manager/install-progress-1', stage: 'complete',
        label: 'Installation verified', steps: { completed: 3, total: 3 } } } : {}),
      message: failed ? 'Preview operation failed. Retry or set up this agent later.' : job.kind === 'setup-command' ? 'Terminal command verified. Open a new terminal window to use it.' : job.kind === 'install-sdk' ? 'Chat support installed.' : job.kind === 'install' ? 'Installation complete.' : 'Sign-in completed.',
      result: failed ? undefined : { verification: outcome === 'unverified' || job.kind === 'profile-login' ? 'unsupported' : 'verified', loginSaved: !installing },
    }
    setJobs(rows => rows.map(row => row.id === job.id ? finished : row))
    if (failed) return
    if (job.kind === 'install') {
      setSnapshot(value => ({ ...value, providers: value.providers.map(info => info.provider === job.provider
        ? { ...info, installed: true, usable: true, version: job.provider === 'opencode' ? '2.0.23' : '1.0.0', error: null } : info) }))
      setCatalog(value => value && ({ ...value, capabilities: value.capabilities.map(info => info.provider === job.provider ? { ...info, installed: true } : info) }))
    } else if (job.kind === 'setup-command') {
      setSnapshot(value => ({ ...value, providers: value.providers.map(info => info.provider === job.provider && info.terminalCommand
        ? { ...info, terminalCommand: { ...info.terminalCommand, ready: true, registered: true, error: null } } : info) }))
    } else if (job.kind === 'install-sdk') {
      setSnapshot(value => ({ ...value, providers: value.providers.map(info => info.provider === job.provider
        ? { ...info, sdkInstallations: info.sdkInstallations?.map(sdk => ({ ...sdk, available: true, version: sdk.requiredVersion, installer: 'uv', error: null })) } : info) }))
    } else if (job.kind === 'profile-login') setCatalog(value => value && ({ ...value, profiles: value.profiles.map(profile =>
      profile.provider === job.provider && profile.profile === job.profile ? { ...profile, readiness: { ready: true, verification: 'unsupported', terminal: { ready: true } } } : profile) }))
    else if (job.auth) setCatalog(value => value && ({ ...value,
      auths: [...value.auths.filter(row => row.provider !== job.provider || row.auth !== job.auth),
        { provider: job.provider, auth: job.auth!, profiles: [], verification: finished.result?.verification as 'verified' | 'unsupported',
          checkedAt: Date.now() }],
    }))
  }
  async function start(provider: SetupProvider, kind: AgentJob['kind'], key: string, args: object = {}) {
    if (!preview) {
      const a = live.current.agents!
      const result = await a.request<AgentJob>('agent-operation-start', { key, provider, kind, ...args })
      if (mounted.current) setJobs(rows => [result, ...rows.filter(row => row.id !== result.id)])
      await a.refreshOperations()
      return result
    }
    const job: AgentJob = { id: key, provider, kind, ...args, status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
      ...(['install', 'install-sdk'].includes(kind) ? { progress: { schema: 'agent-manager/install-progress-1', stage: 'installing',
        label: 'Running installer', steps: { completed: 1, total: 3 } } } : {}),
      cancellable: false, message: kind === 'setup-command' ? 'Setting up terminal command…' : ['install', 'install-sdk'].includes(kind) ? 'Installing on the preview machine…' : 'Complete the simulated provider sign-in.' }
    setJobs(rows => [job, ...rows])
    if (['install', 'install-sdk', 'setup-command', 'check-login'].includes(kind)) timers.current.push(setTimeout(() => { if (mounted.current) finishPreview(job) }, 500))
    return job
  }
  async function createProfile(provider: SetupProvider, profile: string, auth?: string, key: string = randomUUID()) {
    if (!preview) {
      const a = live.current.agents!
      const identity = await createSetupProfile(a, provider, profile, auth, key)
      const fresh = await a.request<Catalog>('catalog')
      if (mounted.current) setCatalog(fresh)
      await a.refresh()
      return identity
    } else {
      setCatalog(value => value && ({ ...value, profiles: [...value.profiles,
      { id: `${provider}/${profile}`, provider, profile, identity: key, auth: null, active_runs: 0, readiness: { ready: provider === 'opencode' } } satisfies Profile] }))
      return key
    }
  }
  async function checkProfile(provider: SetupProvider, profile: string) {
    if (preview) return
    const a = live.current.agents!
    await a.request('agent-profile-check', { provider, profile })
    await detect()
    await a.refresh()
  }
  const operations = preview ? jobs : [...(agents?.operations ?? []), ...jobs.filter(job => !(agents?.operations ?? []).some(row => row.id === job.id))]
  return { snapshot, catalog, progress, setProgress, operations, loading, detected, error, connected, save, detect, reload,
    updateProjectDraft: (projects: ProjectSelection) => { projectDraft.current = projects },
    saveCurrent: (changes: Partial<SetupState> = {}) => {
      const task = projectQueue.current.catch(() => {}).then(() => {
        if (!progressRef.current) throw new Error('Setup is still loading.')
        return save({ ...progressRef.current, ...(projectDraft.current ? { projects: projectDraft.current } : {}), ...changes })
      })
      projectQueue.current = task
      return task
    }, start, createProfile, checkProfile, saveProjects, complete: async (revision: number, skipProjects: boolean) => {
      const saved = await live.current.auth.completeOnboarding(revision, skipProjects)
      progressRef.current = saved
      if (mounted.current) setProgress(saved)
      return saved
    }, previewOS, outcome, setOutcome, finishPreview }
}
