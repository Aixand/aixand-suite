import type { ProfileDecision } from '../agents/profileSelection'

export type DeviceProfileSelection = { mode: 'auto' | 'direct' } | { mode: 'specific'; profile: string }
export type Device = {
  id: string; peerId: string; name: string; ip: string; port: number; os: string
  receiveDir: string | null; paired: boolean; online: boolean
  status: 'ready' | 'offline' | 'unreachable' | 'pairing-required'; error?: string | null
  capabilities?: { files: boolean; codex: boolean; projectSnapshots?: boolean; managerDiscovery?: boolean }
}
export type Peer = { id: string; name: string; ip: string; os: string; connected: boolean }
export type ConnectStatus = { configured: boolean; apiUrl: string; devices?: Device[] }
export type Transfer = {
  id: string; chatId: string; sourceTurnId?: string | null; sourceCallId?: string | null
  deviceId: string; device: string; source: string; name: string; size: number; bytesSent: number
  status: 'preparing' | 'sending' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'uncertain'
  destination: string | null; sha256: string | null; error: string | null
  revision: number; createdAt: number; updatedAt: number
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let index = -1
  do { bytes /= 1024; index++ } while (bytes >= 1024 && index < units.length - 1)
  return `${bytes.toFixed(1)} ${units[index]}`
}

export type ProjectRun = {
  childConversationDeleted?: boolean
  id: string; chatId: string; childChatId: string | null; purpose?: 'copy' | 'test' | 'matrix'; sourceTurnId?: string | null; sourceCallId?: string | null
  projectId: string; project: string; deviceId: string | null; device: string; local?: boolean; os?: string; targets?: ProjectRun[]
  profileSelection?: DeviceProfileSelection; profileDecision?: ProfileDecision | null; selectedProfile?: string | null; executionRoute?: string
  status: string; stage: string; bytesSent: number; size: number; snapshotId: string | null
  cwd: string | null; fileCount?: number; sourceBytes?: number; excludedCount?: number; gitIgnored?: boolean
  cancelRequested: boolean; error: string | null; revision: number; createdAt: number; updatedAt: number
  report: { outcome: 'passed' | 'failed' | 'blocked' | 'unconfirmed'; summary: string; checks: { command: string; exitCode: number | null }[] } | null
}

export type DeviceManagers = {
  schema: string
  packages: Record<string, { installed: boolean; version: string | null; configured?: boolean; usable?: boolean; separateEnvironment?: boolean }>
  profiles: { profile: string; auth: string | null }[]
  runtime: { ready: boolean; kind?: string }
  managedCodex: boolean
  resourceIntegrations?: Record<string, { manager: string; available: boolean; status: string; reason?: { message: string } | null }>
  reason: string | null
}

export type BackgroundActivity = {
  id: string; kind: 'project' | 'workflow' | 'chat'; title: string; device: string; deviceId: string | null
  status: string; error?: string | null; updatedAt?: number; chatId?: string | null
  conversationDeleted: boolean; workflowId?: string
}
