import { sessionSocket } from '../auth/client'
import { requestId } from '../terminals/connection'
import type { Target } from './ResourcePicker'
import type { McpBinding, McpSnapshot } from './mcp'
import type { ChatCommand, SessionConfig } from '../chats/commands'

// Provider identities come from Agent Manager's catalog.
export type Provider = string
export type AccountObservation = {
  kind: string; id: string | null; label: string; scope: string; state: string
  configured: boolean; statusLabel: string; evidence: string
  checkedAt?: number | null; stale?: boolean; principal?: string | null
  lastSuccessfulCheckAt?: number | null; profiles?: string[]; variable?: string
  usage?: { state: 'limit-reached' | 'available' } | null
}
export type LaunchReadiness = { ready: boolean; state?: string; verification?: string; reason?: string | null; accountState?: string }
export type Profile = {
  revision?: string
  preferred?: boolean
  authMode?: 'native' | 'files'
  homeScope?: string
  authentication?: { terminal: AccountObservation; chat: AccountObservation }

  id: string
  provider: Provider
  profile: string
  auth: string | null
  model?: string | null
  profile_id?: string
  auth_id?: string | null
  sdk_credential?: SdkCredential | null
  sdk_authentication?: 'profile-login' | 'api-key'
  claude_account?: { id: string; name: string; directory: string; owned: boolean } | null
  rename_can_drain?: boolean
  active_runs: number
  identity?: string
  readiness?: LaunchReadiness & { terminal?: LaunchReadiness; chat?: LaunchReadiness; backends?: Record<string, LaunchReadiness> }
  resources?: { revision: string; mcp: { target: Target; required?: boolean }[] }
  mcp?: McpBinding
}
export type Auth = {
  provider: Provider; auth: string; profiles: string[]; auth_id?: string; rename_can_drain?: boolean
  signedInAt?: number | null; checkedAt?: number | null
  state?: string; lastSuccessfulCheckAt?: number | null
  verification?: 'verified' | 'unsupported' | 'failed' | null
}
export type OperationKind = 'new-login' | 'reauthenticate' | 'import-login' | 'check-login' | 'profile-login' | 'install' | 'install-sdk' | 'update' | 'repair' | 'uninstall' | 'disable' | 'enable'
export type InstallationProgress = {
  schema: 'agent-manager/install-progress-1'
  stage: 'preparing' | 'downloading' | 'installing' | 'removing' | 'verifying' | 'complete'
  label: string
  steps: { completed: number; total: number | null }
  transfer?: { completed: number; total: number | null; unit: 'bytes' }
}
export type AgentJob = {
  id: string; provider: Provider; kind: OperationKind; auth?: string | null; profile?: string | null
  method?: string | null; device?: boolean; structured?: boolean; phase?: string
  installationRevision?: string; confirmed?: boolean
  progress?: InstallationProgress | null
  loginAttemptId?: string | null; origin?: string | null; observed?: boolean
  assignProfile?: string | null; expectedProfileRevision?: string | null
  sourceChatId?: string | null; sourceTurnId?: string | null; sourceCallId?: string | null
  status: 'queued' | 'starting' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled'
  sessionId?: string | null; message: string; createdAt: number; updatedAt: number
  cancellable: boolean; exitCode?: number | null; result?: {
    verification?: string; loginSaved?: boolean; credentialPresent?: boolean; authMethod?: string; assigned?: boolean; assignmentError?: string
    recovery?: { id: string; profile: string; phase: string; blockers: { kind: string; count?: number }[] }[]
  }
}
export type ProviderInfo = {
  label?: string; description?: string; available?: boolean
  provider: Provider; installed: boolean; version: string | null; latestVersion?: string | null
  usable?: boolean
  setup?: import('../auth/agentSetup').SetupGuide | null
  method: string | null; path: string | null; canUpdate: boolean; error: string | null
  checkedAt?: number; updateError?: string | null; activeProfiles: string[]
  methods: { id: string; label: string; error: string | null }[]
  maintenanceNote?: string
  software?: {
    disabled: boolean; bundled: boolean; revision: string; automatic: boolean; reason: string | null
    method: string | null; path: string | null; targets: string[]; manualCommands: string[]
    manualSteps: string[]; docs: string | null; preservesAccounts: boolean
  }
  sdkInstallations?: {
    backend: string; label: string; package: string; version: string | null; requiredVersion: string
    installer: string | null; available: boolean; error: string | null
  }[]
}
export type ProviderDiagnostics = { checkedAt: number; checks: { label: string; status: 'passed' | 'failed'; message: string }[] }
export type SdkCredential = { id: string; provider: Provider; name: string; method: 'api-key' | 'google-adc'; revision: string }
export type Backend = { id: string; provider: Provider; label: string; available: boolean; reason?: string; default?: boolean; modelInput?: 'text'; commandPreview?: ChatCommand[]; controls: Record<string, boolean> }
export type BackendDiscovery = {
  id: string; epoch: string; generation: string; sequence: number; sourceRevision: string
  provider: Provider; profile: string | null; backend: string; state: 'running' | 'ready' | 'error' | 'stale'
  discoveredAt: number | null; models: Model[]; modelsSource?: 'sdk' | 'configured' | 'provider'
  settings: SessionConfig[]; commands: ChatCommand[]; limitations: string[]; error: string
}
export type Catalog = {
  backends?: Backend[]
  profiles: Profile[]
  auths: Auth[]
  capabilities: {
    provider: Provider
    installed: boolean
    savedModels: boolean
    budgets: boolean
    authMode?: 'files' | 'native'
    homeScope?: 'shared' | 'isolated'
    savedAuth?: boolean
    label?: string
    defaultLoginMethod?: string
    loginMethods?: string[]
    importLogin?: boolean
  }[]
  cwd: string
}
export type Budget = {
  profile: string
  weekly_left?: number | null
  short_left?: number | null
  bucket?: string
  label?: string
  window?: string
  scope?: Record<string, string>
  remaining_percent?: number | null
  checked_at?: number
  status?: string
  source?: string
  resets_at?: number | null
  error?: string
}
export type Observation = {
  lifecycle: string
  execution: string
  interaction: string
  constraint: string
  health: string
}
export type Run = {
  labels?: Record<string, string>
  run_id: string
  provider: Provider
  profile: string
  auth: string | null
  session_id: string | null
  status: string
  cwd: string | null
  active: boolean
  created_at_millis: number | null
  error: string | null
  observation: Observation | null
  mode?: 'terminal' | 'app-server'
  thread_id?: string | null
  app_server_run_id?: string | null
  launch_kind?: 'fresh' | 'resume' | 'app-server' | 'app-server-client'
  mcp?: McpSnapshot | null
}
export type Sessions = { runs: Run[]; runtimeError: string | null }
export type SavedSession = {
  key: string; id: string; provider: Provider; profile: string; auth: string | null
  title: string; cwd: string; home: string; updatedAt: number; archived: boolean
  state: 'saved' | 'running' | 'attention'; terminalId: string | null; runIds: string[]
  canContinue: boolean; parentId?: string | null
}
export type SessionLibrary = {
  sessions: SavedSession[]; total: number; nextOffset: number | null
  homes: { id: string; provider: Provider; profile: string }[]; projects: string[]
  counts: Record<'all' | 'running' | 'attention' | 'archived', number>; errors: string[]
}
export type SessionTranscript = {
  session: SavedSession
  items: (import('../chats/model').ChatItem & { timestamp?: string; raw?: string })[]
  total: number; nextBefore: number | null; partial: boolean; error?: string | null
}
export type Model = { id: string; name: string; free: boolean; description?: string }
export class AgentError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly runId?: string,
    readonly uncertain = false,
    readonly recovery?: unknown,
  ) {
    super(message)
  }
}

export class AgentsConnection {
  private socket: WebSocket
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private ready = false
  private closed = false
  private reason = ''
  constructor(
    onReady: () => void,
    onClose: (message: string) => void,
    onEvent?: (message: unknown) => void,
  ) {
    this.socket = sessionSocket('/api/agents/ws')
    this.socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
        if (!message || typeof message.type !== 'string')
          throw new Error('Invalid agent message')
      } catch {
        this.reason = 'Invalid agent response. Reconnect and check Terminals.'
        this.socket.close()
        return
      }
      if (message.type === 'ready') {
        this.ready = true
        onReady()
        return
      }
      if (message.type === 'fatal') {
        this.reason = message.message
        this.socket.close()
        return
      }
      if (['backend-discovery-updated', 'command-updated', 'command-activity', 'connect-activity-updated', 'connect-project-updated', 'connect-transfer-updated', 'chat-event', 'chat-voice-event', 'projects-changed', 'project-discovery-updated', 'profiles-changed', 'agent-operation-updated', 'agent-management-updated', 'chat-created', 'chat-updated', 'chat-deleted', 'workspace-reset', 'launch-updated', 'workflow-updated', 'prompts-changed', 'mcps-changed', 'skills-changed', 'resources-changed', 'spawn-settings-changed', 'approval-settings-changed'].includes(message.type)) {
        onEvent?.(message)
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.type === 'error')
        request.reject(
          new AgentError(message.message, message.code, message.runId, message.uncertain, message.recovery),
        )
      else request.resolve(message.result)
    }
    this.socket.onclose = (event) => {
      this.ready = false
      const message =
        this.reason ||
        event.reason ||
        'Agent connection lost. Reconnect and check Terminals; pending operations were not retried.'
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(new AgentError(message, 'connection_lost'))
      }
      this.pending.clear()
      if (!this.closed) onClose(message)
    }
  }
  request<T>(op: string, args: object = {}): Promise<T> {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new AgentError('Connect to Agent Manager first.'))
    if (this.pending.size >= 16 || this.socket.bufferedAmount > 128 * 1024)
      return Promise.reject(new AgentError('Agent connection is busy.'))
    const id = requestId()
    const payload = JSON.stringify({ id, op, args })
    if (new TextEncoder().encode(payload).byteLength > 64 * 1024)
      return Promise.reject(new AgentError('This request exceeds 64 KiB. Shorten its content before sending.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(
            new AgentError(
              'Agent request timed out. Refresh agents and check Terminals before retrying a launch; the operation may still finish.',
              'timeout',
            ),
          )
        },
        op === 'budgets' ? 185_000 : 95_000,
      )
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.socket.send(payload)
    })
  }
  close() {
    this.closed = true
    this.socket.close()
  }
}
