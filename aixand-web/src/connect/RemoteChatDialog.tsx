import { useEffect, useId, useRef, useState } from 'react'
import { Button, Icon, Select, TextField, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { AgentsModel } from '../agents/model'
import { permissionModes, type PermissionMode } from '../agents/permissions'
import type { ChatSnapshot } from '../chats/model'
import { requestId } from '../terminals/connection'
import type { ConnectStatus, Device, DeviceManagers, DeviceProfileSelection } from './model'
import './connect.css'
import { ManagerInventory } from './ManagerInventory'

type CodexStatus = { installed: boolean; authenticated: boolean; version: string | null; roots: string[]; error?: string | null }

export function RemoteChatDialog({ open, onOpenChange, agents, initialDevice = '', create, onCreated }: {
  open: boolean
  onOpenChange: (value: boolean) => void
  agents: AgentsModel
  initialDevice?: string
  create: (args: object) => Promise<ChatSnapshot>
  onCreated: (chat: ChatSnapshot) => void
}) {
  const theme = useThemeAttributes()
  const descriptionId = useId()
  const api = useRef(agents); api.current = agents
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceId, setDeviceId] = useState(initialDevice)
  const [cwd, setCwd] = useState('')
  const [permission, setPermission] = useState<PermissionMode>('workspace-write')
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [managers, setManagers] = useState<DeviceManagers | null>(null)
  const [remoteProfile, setRemoteProfile] = useState('auto')
  const [managerError, setManagerError] = useState('')
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState<{ key: string; deviceId: string; cwd: string; permissionMode: PermissionMode; profileSelection: DeviceProfileSelection } | null>(null)
  const connected = agents.status === 'connected'
  useEffect(() => {
    if (!open || !connected) return
    let alive = true
    void api.current.request<ConnectStatus>('connect-devices').then((result) => {
      if (alive) {
        setDevices(result.devices ?? [])
        if (initialDevice && !attempt) setDeviceId(initialDevice)
      }
    }).catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [open, connected, initialDevice, attempt])
  useEffect(() => {
    setCodex(null)
    if (!open || !connected || !deviceId) return
    let alive = true
    setChecking(true); setError('')
    void api.current.request<CodexStatus>('connect-codex-inspect', { deviceId }).then((result) => {
      if (alive) setCodex(result)
    }).catch((cause: Error) => { if (alive) setError(cause.message) })
      .finally(() => { if (alive) setChecking(false) })
    return () => { alive = false }
  }, [open, connected, deviceId])

  const managerDiscovery = devices.find((device) => device.id === deviceId)?.capabilities?.managerDiscovery
  useEffect(() => {
    setManagers(null); setManagerError('')
    if (!attempt) setRemoteProfile('auto')
    if (!open || !connected || !deviceId || !managerDiscovery) return
    let alive = true
    void api.current.request<DeviceManagers>('connect-managers-inspect', { deviceId }).then((result) => {
      if (alive) setManagers(result)
    }).catch((cause: Error) => { if (alive) setManagerError(cause.message) })
    return () => { alive = false }
  }, [open, connected, deviceId, managerDiscovery, attempt])

  async function submit() {
    if (busy || !connected || !deviceId || !cwd.trim()) return
    setBusy(true); setError('')
    try {
      let operation = attempt
      if (!operation) {
        const checked = await agents.request<{ cwd: string }>('connect-codex-inspect', { deviceId, cwd: cwd.trim() })
        operation = { key: requestId(), deviceId, cwd: checked.cwd, permissionMode: permission, profileSelection: remoteProfile.startsWith('profile:') ? { mode: 'specific', profile: remoteProfile.slice(8) } : { mode: remoteProfile as 'auto' | 'direct' } }
        setAttempt(operation)
      }
      const chat = await create({ ...operation, profile: null, mode: 'work' })
      onCreated(chat)
      onOpenChange(false)
      setAttempt(null); setCwd('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start the remote chat') }
    finally { setBusy(false) }
  }

  return <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={open} isDismissable={!busy}
    onOpenChange={(value) => { if (!busy) onOpenChange(value) }}>
    <Modal className="bbb-modal">
      <Dialog className="bbb-dialog" aria-describedby={descriptionId}>
        <div className="bbb-dialog__header">
          <div className="bbb-dialog__heading">
            <Heading slot="title">Start a remote chat</Heading>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close remote chat dialog" disabled={busy} onPress={() => onOpenChange(false)}><Icon name="x" /></Button>
          </div>
          <p id={descriptionId} className="bbb-dialog__description">Codex runs on the selected device, using its login and project files. The conversation appears here.</p>
        </div>
        <div className="bbb-dialog__body">
          <form className="form-stack command-project-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <Select label="Run on device" variant="outlined" value={deviceId} disabled={busy || Boolean(attempt) || !connected}
              options={devices.map((device) => ({ id: device.id, label: `${device.name}${device.status !== 'ready' ? ' · unavailable' : device.capabilities?.codex ? '' : ' · file transfer only'}`,
                disabled: device.status !== 'ready' || !device.capabilities?.codex }))}
              onChange={setDeviceId} />
            {!devices.length && <p>Pair a device in Settings → Devices to start a remote chat.</p>}
            {checking && <p role="status">Checking Codex on the device…</p>}
            {codex && <p role="status">{codex.authenticated ? `${codex.version ?? 'Codex'} · Signed in on device` : codex.error ?? 'Sign in to Codex on the device first.'}</p>}
            {deviceId && <Select label="Codex configuration on device" variant="outlined" value={remoteProfile}
              disabled={busy || Boolean(attempt)}
              options={[{ id: 'auto', label: 'Auto · highest remaining allowance', disabled: !managers?.managedCodex }, { id: 'direct', label: 'Direct Codex · native login' }, ...(managers?.profiles ?? []).map((profile) => ({
                id: `profile:${profile.profile}`, label: `Agent Manager · ${profile.profile}`, disabled: !managers?.managedCodex,
              }))]}
              onChange={setRemoteProfile} />}
            {managerDiscovery && !managers && !managerError && <p role="status">Checking managers on the device…</p>}
            {managerError && <p>{managerError}</p>}
            {managers && <details><summary>Device manager details</summary><ManagerInventory value={managers} /></details>}
            {remoteProfile === 'auto' && <p>Agent Manager selects the eligible account with the most weekly allowance remaining on this device. The chat keeps that account.</p>}
            {remoteProfile.startsWith('profile:') && <p>Uses the {remoteProfile.slice(8)} profile and its saved resources on this device.</p>}
            {deviceId && !managerDiscovery && <p>Auto requires Agent Manager and an updated companion. Select Direct Codex to use this device’s native login.</p>}
            <TextField label="Project directory on device" value={cwd} maxLength={4096} required disabled={busy || Boolean(attempt)}
              placeholder="~/dev/my-project" onChange={(event) => setCwd(event.target.value)} />
            {codex?.roots?.length ? <p className="settings-help">Project roots: {codex.roots.join(', ')}</p> : null}
            <Select label="Remote chat access" variant="outlined" value={permission} options={[...permissionModes]}
              disabled={busy || Boolean(attempt)} onChange={(value) => setPermission(value as PermissionMode)} />
            {error && <p role="alert">{error}</p>}
            {attempt && error && <a href={`#/chat/${attempt.key}`} onClick={() => onOpenChange(false)}>Open this chat to inspect its state</a>}
            <div className="command-project-form-actions">
              <Button variant="ghost" disabled={busy} onPress={() => onOpenChange(false)}>Close</Button>
              <Button type="submit" loading={busy} disabled={busy || checking || !connected || !deviceId || !cwd.trim() || (remoteProfile !== 'direct' ? !managers?.managedCodex : !codex?.installed || !codex.authenticated)}>
                {attempt ? 'Retry same chat' : 'Start remote chat'}
              </Button>
            </div>
          </form>
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>
}
