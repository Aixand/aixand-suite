import type { AgentJob, Catalog, Provider, ProviderInfo } from '../agents/client'
import { isPendingOperation } from '../agents/operationState'

export const setupProviders = ['codex', 'opencode', 'claude', 'antigravity', 'copilot'] as const
export type SetupProvider = string
export const setupLabel: Record<SetupProvider, string> = {
  codex: 'Codex', opencode: 'OpenCode', claude: 'Claude Code', antigravity: 'Antigravity', copilot: 'GitHub Copilot',
}
export type SetupEnvironment = {
  os: 'linux' | 'macos' | 'windows' | 'unknown'
  label: string
  architecture: string
  wsl: boolean
  tools: string[]
  managedSupported: boolean
}
export type SetupGuide = {
  docs: string
  verifyCommand: string
  methods: { id: string; label: string; command: string; error: string | null }[]
}
export type SetupSnapshot = { providers: ProviderInfo[]; environment?: SetupEnvironment }
export type ProjectSelection = { directory: string; skipped: boolean; entries: { id: string; path: string; name: string; projectId?: string; error?: string }[] }
export type SetupExtra = {
  mode: 'account' | 'profile' | null
  resumeMode?: 'account' | 'profile'
  auth: string
  loginName: string
  profileName: string
  operationId: string | null
  profileRequestId?: string
  profileIdentity?: string
  nativeProfile: string | null
}
export type SetupDraft = {
  auth: string
  loginName: string
  profileName: string
  operationId: string | null
  profileRequestId?: string
  profileIdentity?: string
  profileEdited?: boolean
  nativeProfile: string | null
  done: boolean
  deferred: boolean
  extra?: SetupExtra | null
}
export type SetupProgress = {
  status: 'pending' | 'complete'
  version?: 2
  manual?: boolean
  projects?: ProjectSelection
  step: 'providers' | 'install' | 'login' | 'profile' | 'projects' | 'done'
  selected: SetupProvider[]
  selectionInitialized: boolean
  selectionExplicit?: boolean
  current: SetupProvider | null
  drafts: Partial<Record<SetupProvider, SetupDraft>>
}
export type SetupState = SetupProgress & { revision: number }
export const initialSetup = (): SetupState => ({
  status: 'pending', step: 'providers', selected: [], selectionInitialized: false, current: null, drafts: {}, revision: 1,
})
export const setupDraft = (): SetupDraft => ({
  auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null, done: false, deferred: false,
})
export const providerUsable = (provider?: ProviderInfo) => !!provider && (provider.usable ?? (provider.installed && !!provider.version && !provider.error))
export const isSetupProvider = (provider: Provider): provider is SetupProvider => !!provider
export function setupName(provider: string, source: SetupSnapshot | Catalog) {
  return ('providers' in source ? source.providers.find(row => row.provider === provider)?.label
    : source.capabilities.find(row => row.provider === provider)?.label) ?? setupLabel[provider] ?? provider
}
export function loginOptions(provider: string, catalog: Catalog | null) {
  return catalog?.capabilities.find(row => row.provider === provider)?.defaultLoginMethod === 'device'
    ? { device: true, structured: true } : {}
}

export type SetupSection = 'install' | 'account' | 'profile'
export function setupNextSection(installed: boolean, accountReady: boolean, profileReady: boolean, pending?: AgentJob): SetupSection | null {
  if (!installed || pending && ['install', 'install-sdk', 'update', 'repair'].includes(pending.kind)) return 'install'
  if (!accountReady || pending) return 'account'
  return profileReady ? null : 'profile'
}

export function setupAccount(provider: SetupProvider, progress: SetupState | null, catalog: Catalog | null, operations: AgentJob[]) {
  const draft = progress?.drafts[provider] ?? setupDraft()
  const capability = catalog?.capabilities.find(row => row.provider === provider)
  const native = capability?.authMode === 'native' || capability?.savedAuth === false
  const logins = catalog?.auths.filter(row => row.provider === provider) ?? []
  const login = logins.find(row => row.auth === draft.auth)
  const job = operations.find(row => row.id === draft.operationId)
  const pending = operations.find(row => row.provider === provider && isPendingOperation(row))
  const primaryPending = operations.find(row => {
    if (row.provider !== provider || !isPendingOperation(row)) return false
    if (['install', 'update', 'repair'].includes(row.kind)) return true
    return row.kind === 'profile-login' ? !row.profile || row.profile === draft.nativeProfile : !row.auth || row.auth === draft.auth
  })
  const checked = operations.filter(row => row.provider === provider && row.auth === draft.auth && row.kind === 'check-login')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const savedVerification = checked && checked.updatedAt >= (login?.checkedAt ?? 0)
    ? checked.status === 'succeeded' ? checked.result?.verification : checked.status === 'failed' ? 'failed' : null
    : login?.verification ?? (job?.status === 'succeeded' && job.auth === draft.auth && job.result?.verification === 'verified' ? 'verified' : null)
  const nativeJob = operations.filter(row => row.provider === provider && row.profile === draft.nativeProfile && row.kind === 'profile-login')
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  const verification = native ? (nativeJob?.status === 'succeeded' ? nativeJob.result?.verification ?? 'unsupported'
    : catalog?.profiles.find(row => row.provider === provider && row.profile === draft.nativeProfile)?.readiness?.verification) : savedVerification
  const nativeReady = catalog?.profiles.some(row => row.provider === provider && row.profile === draft.nativeProfile &&
    (row.authentication ? row.authentication.terminal.configured
      : row.readiness?.terminal?.ready ?? row.readiness?.ready)) === true
  // Claude's official account check owns readiness, including after a prior
  // successful command whose credentials were not saved or are now signed out.
  const nativeSignedIn = native && !!draft.nativeProfile && (provider === 'claude' ? nativeReady : nativeJob?.status === 'succeeded' || nativeReady)
  const ready = native ? nativeSignedIn : !!login && ['verified', 'unsupported'].includes(verification ?? '')
  return { draft, native, logins, login, job, pending, primaryPending, verification, nativeSignedIn, ready }
}

export function setupProfileMatches(provider: SetupProvider, progress: SetupState | null, catalog: Catalog | null, operations: AgentJob[]) {
  const { draft, native, login } = setupAccount(provider, progress, catalog, operations)
  const profile = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
  return !!profile && (native ? draft.nativeProfile === profile.profile : profile.auth === draft.auth && !!login)
}

export function setupAgentReady(provider: SetupProvider, progress: SetupState, snapshot: SetupSnapshot, catalog: Catalog, operations: AgentJob[]) {
  const account = setupAccount(provider, progress, catalog, operations)
  return !account.draft.deferred && account.draft.done && !account.primaryPending && account.ready
    && providerUsable(snapshot.providers.find(row => row.provider === provider))
    && setupProfileMatches(provider, progress, catalog, operations)
}

// Preview data is deliberately local. No host probe, package installation, or
// authentication request is performed when replaying onboarding.
export function previewEnvironment(os: string): SetupEnvironment {
  return {
    os: os === 'wsl' ? 'linux' : os as SetupEnvironment['os'],
    label: ({ macos: 'macOS', windows: 'Windows', linux: 'Linux', wsl: 'Linux (WSL)' } as Record<string, string>)[os],
    architecture: os === 'macos' ? 'arm64' : 'x64', wsl: os === 'wsl',
    tools: os === 'windows' ? ['node', 'npm'] : ['curl', 'tar', 'sh', 'bash', 'node', 'npm', ...(os === 'macos' ? ['brew'] : [])],
    managedSupported: true,
  }
}
export function previewProviders(environment: SetupEnvironment): ProviderInfo[] {
  return setupProviders.map(provider => {
    const managed = environment.managedSupported
    const npm = provider === 'copilot' && environment.os === 'windows'
    const url = provider === 'copilot' ? 'https://gh.io/copilot-install' : provider === 'codex' ? 'https://chatgpt.com/codex/install.sh' : 'https://opencode.ai/v2/install'
    const docs = { codex: 'https://learn.chatgpt.com/docs/codex/cli', opencode: 'https://opencode.ai/v2/docs/',
      claude: 'https://code.claude.com/docs/en/setup', antigravity: 'https://antigravity.google/docs/getting-started?tab=cli',
      copilot: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli' }[provider]
    const command = npm ? 'npm install -g @github/copilot'
      : provider === 'antigravity' ? environment.os === 'windows' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
      : provider === 'claude' ? environment.os === 'windows' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'
      : environment.os === 'windows' ? provider === 'codex' ? 'irm https://chatgpt.com/codex/install.ps1 | iex' : ''
        : `curl -fsSL ${url} | ${provider === 'codex' ? 'sh' : 'bash'}`
    const method = npm ? 'npm' : 'installer'
    const label = npm ? 'npm' : 'Official installer'
    return { provider, label: setupLabel[provider], installed: provider === 'codex', usable: provider === 'codex', version: provider === 'codex' ? '0.162.1' : null,
      path: provider === 'codex' ? '/preview/bin/codex' : null, method: provider === 'codex' ? 'installer' : null,
      canUpdate: false, error: null, activeProfiles: [],
      methods: managed ? [{ id: method, label, error: null }] : [],
      setup: { docs, verifyCommand: `${provider === 'antigravity' ? 'agy' : provider} --version`,
        methods: command ? [{ id: managed ? method : 'manual', label, command, error: null }] : [] },
    }
  })
}
export function previewCatalog(): Catalog {
  return { profiles: [], auths: [], cwd: '/preview/projects', capabilities: setupProviders.map(provider => ({
    provider, label: setupLabel[provider], defaultLoginMethod: provider === 'codex' ? 'device' : 'terminal', installed: provider === 'codex', savedModels: true, budgets: provider === 'codex',
    authMode: ['antigravity', 'copilot'].includes(provider) ? 'native' : 'files', savedAuth: !['antigravity', 'copilot'].includes(provider),
  })) }
}
