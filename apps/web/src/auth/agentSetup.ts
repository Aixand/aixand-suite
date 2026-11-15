import type { AgentJob, Catalog, Provider, ProviderInfo } from '../agents/client'
import { isPendingOperation } from '../agents/operationState'

export const setupProviders = ['codex', 'opencode'] as const
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
  loginMethod?: string
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
  loginMethod?: string
  freeModels?: boolean
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
export const providerTerminalUsable = (provider?: ProviderInfo) => !!provider && !provider.software?.disabled
  && (provider.terminalUsable ?? providerUsable(provider))
export const providerChatSupportReady = (provider?: ProviderInfo) =>
  (provider?.chatCompatibility?.compatible ?? true) && (provider?.sdkInstallations ?? []).every(sdk => sdk.required === false || sdk.available)
export const providerVersionReady = (provider?: ProviderInfo) => !(provider?.chatCompatibility && !provider.chatCompatibility.compatible
  && provider.compatibility && !provider.compatibility.compatible)
export const providerSdksInstalled = (provider?: ProviderInfo) => !!provider?.sdkInstallations?.length && provider.sdkInstallations.every(sdk => sdk.available)
export const providerChatSupportStatus = (provider?: ProviderInfo) => providerSdksInstalled(provider) ? 'Installed'
  : providerChatSupportReady(provider) ? 'Optional SDK needs setup' : 'Needs installation'
export const providerCommandReady = (provider?: ProviderInfo) => provider?.terminalCommand?.ready ?? true
export const providerInstallationReady = (provider?: ProviderInfo) => providerTerminalUsable(provider) && providerCommandReady(provider) && providerChatSupportReady(provider)
export const isSetupProvider = (provider: Provider): provider is SetupProvider => setupProviders.some(value => value === provider)
export function setupName(provider: string, source: SetupSnapshot | Catalog) {
  return ('providers' in source ? source.providers.find(row => row.provider === provider)?.label
    : source.capabilities.find(row => row.provider === provider)?.label) ?? setupLabel[provider] ?? provider
}
export function loginOptions(provider: string, catalog: Catalog | null) {
  return catalog?.capabilities.find(row => row.provider === provider)?.defaultLoginMethod === 'device'
    ? { device: true, structured: true } : {}
}

export type SetupSection = 'install' | 'sdk' | 'account' | 'profile'
export const setupSections = (provider?: ProviderInfo): SetupSection[] => [
  'install', ...(provider?.sdkInstallations?.length ? ['sdk' as const] : []), 'account', 'profile',
]
export const setupSectionLabel: Record<SetupSection, string> = { install: 'Installation', sdk: 'Chat support', account: 'Account', profile: 'Profile' }
export function setupNextSection(installed: boolean, accountReady: boolean, profileReady: boolean, pending?: AgentJob, chatSupportReady = true): SetupSection | null {
  if (!installed || pending && ['install', 'setup-command', 'update', 'repair'].includes(pending.kind)) return 'install'
  if (!chatSupportReady || pending?.kind === 'install-sdk') return 'sdk'
  if (!accountReady || pending) return 'account'
  return profileReady ? null : 'profile'
}

export function failedProviderRepair(provider: string, operations: AgentJob[]) {
  const latest = operations.filter(row => row.provider === provider && ['install', 'repair', 'update'].includes(row.kind))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  return latest?.kind === 'repair' && ['failed', 'cancelled'].includes(latest.status) ? latest : undefined
}

export function setupAccount(provider: SetupProvider, progress: SetupState | null, catalog: Catalog | null, operations: AgentJob[]) {
  const draft = progress?.drafts[provider] ?? setupDraft()
  const capability = catalog?.capabilities.find(row => row.provider === provider)
  const native = isSetupProvider(provider) || capability?.authMode === 'native' || capability?.savedAuth === false
  const logins = catalog?.auths.filter(row => row.provider === provider) ?? []
  const login = logins.find(row => row.auth === draft.auth)
  const job = operations.find(row => row.id === draft.operationId)
  const pending = operations.find(row => row.provider === provider && isPendingOperation(row))
  const primaryPending = operations.find(row => {
    if (row.provider !== provider || !isPendingOperation(row)) return false
    if (['install', 'install-sdk', 'setup-command', 'update', 'repair'].includes(row.kind)) return true
    return row.kind === 'profile-login' ? !row.profile || row.profile === draft.nativeProfile : !row.auth || row.auth === draft.auth
  })
  const checked = operations.filter(row => row.provider === provider && row.auth === draft.auth && row.kind === 'check-login')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const savedVerification = checked && checked.updatedAt >= (login?.checkedAt ?? 0)
    ? checked.status === 'succeeded' ? checked.result?.verification : checked.status === 'failed' ? 'failed' : null
    : login?.verification ?? (job?.status === 'succeeded' && job.auth === draft.auth && job.result?.verification === 'verified' ? 'verified' : null)
  const nativeProfile = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.nativeProfile)
  const verification = native ? nativeProfile?.readiness?.verification : savedVerification
  const nativeReady = nativeProfile?.readiness?.ready === true
  const nativeSignedIn = native && !!draft.nativeProfile && nativeReady
  const ready = native ? nativeSignedIn : !!login && ['verified', 'unsupported'].includes(verification ?? '')
  return { draft, native, logins, login, job, pending, primaryPending, verification, nativeSignedIn, ready }
}

export function setupProfileMatches(provider: SetupProvider, progress: SetupState | null, catalog: Catalog | null, operations: AgentJob[]) {
  const { draft, native, login } = setupAccount(provider, progress, catalog, operations)
  const profile = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
  return !!profile && (!draft.profileIdentity || draft.profileIdentity === profile.identity)
    && (native ? draft.nativeProfile === profile.profile : profile.auth === draft.auth && !!login)
}

export function setupAgentReady(provider: SetupProvider, progress: SetupState, snapshot: SetupSnapshot, catalog: Catalog, operations: AgentJob[]) {
  const account = setupAccount(provider, progress, catalog, operations)
  return !account.draft.deferred && account.draft.done && !account.primaryPending && account.ready
    && providerInstallationReady(snapshot.providers.find(row => row.provider === provider))
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
  return setupProviders.map(provider => ({
    provider, label: setupLabel[provider], installed: provider === 'codex', usable: provider === 'codex',
    version: provider === 'codex' ? '0.166.0' : null, path: provider === 'codex' ? '/preview/bin/codex' : null,
    method: provider === 'codex' ? 'installer' : null, canUpdate: false, error: null, activeProfiles: [],
    methods: environment.managedSupported ? [{ id: 'installer', label: 'Managed installation', error: null }] : [],
    setup: { docs: provider === 'codex' ? 'https://learn.chatgpt.com/docs/codex/cli' : 'https://opencode.ai/v2/docs/',
      verifyCommand: `${provider} --version`,
      methods: [{ id: 'installer', label: 'Managed installation', command: `agent install ${provider} --yes`, error: null }] },
  }))
}
export function previewCatalog(): Catalog {
  return { profiles: [], auths: [], cwd: '/preview/projects', capabilities: setupProviders.map(provider => ({
    provider, label: setupLabel[provider], loginMethods: provider === 'codex' ? ['browser', 'device'] : ['terminal'], defaultLoginMethod: provider === 'codex' ? 'browser' : 'terminal', installed: provider === 'codex',
    savedModels: true, budgets: provider === 'codex', authMode: 'native', savedAuth: false,
  })) }
}
