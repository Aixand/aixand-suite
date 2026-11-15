import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useRef, useState } from 'react'
import { Accordion, Badge, Button, Dialog, DropdownMenu, Icon, ListRow, Select, SettingsSection, TextField, Tooltip } from 'bbb-design'
import { Disclosure, DisclosurePanel } from 'react-aria-components'
import type { AgentsModel } from '../agents/model'
import { requestId } from '../terminals/connection'
import type { ConnectStatus, Device, Peer, DeviceManagers } from './model'
import './connect.css'
import { ManagerInventory } from './ManagerInventory'
import { RemoteChatDialog } from './RemoteChatDialog'
import type { ChatSnapshot } from '../chats/model'
import { BackgroundWork } from './BackgroundWork'
import { SettingsHelp } from '../settings/SettingsHelp'
import { workspaceFetch } from '../auth/transport'

export function DevicesSettings({ agents, active = true }: { agents: AgentsModel; active?: boolean }) {
  const fieldVariant = useContentFieldVariant()
  const api = useRef(agents); api.current = agents
  const [settings, setSettings] = useState<ConnectStatus | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [peers, setPeers] = useState<Peer[]>([])
  const [apiUrl, setApiUrl] = useState('https://api.netbird.io/api')
  const [token, setToken] = useState('')
  const [peerId, setPeerId] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [port, setPort] = useState('47831')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [remove, setRemove] = useState<string | null>(null)
  const [remoteDevice, setRemoteDevice] = useState<string | null>(null)
  const [managers, setManagers] = useState<Record<string, DeviceManagers>>({})
  const [dialog, setDialog] = useState<'connection' | 'pairing' | null>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const pairing = useRef<{ signature: string; key: string } | null>(null)
  const connected = agents.status === 'connected'

  useEffect(() => {
    if (!active) setDialog(null)
  }, [active])

  useEffect(() => {
    if (!connected) return
    let alive = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await api.current.request<ConnectStatus>('connect-devices')
        if (alive) {
          setSettings(result); setDevices(result.devices ?? [])
          if (result.apiUrl) setApiUrl((previous) => previous === 'https://api.netbird.io/api' ? result.apiUrl : previous)
        }
      } catch (cause) { if (alive) setError((cause as Error).message) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [connected])

  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  async function refresh() {
    const result = await agents.request<ConnectStatus>('connect-devices')
    setSettings(result); setDevices(result.devices ?? [])
  }
  function closeSetup() {
    setDialog(null)
    requestAnimationFrame(() => menuTrigger.current?.focus())
  }
  const peer = peers.find((item) => item.id === peerId)
  const showingConnection = dialog === 'connection' || !settings?.configured
  const connectionForm = <form className="connect-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
        const result = await agents.request<ConnectStatus>('connect-configure', { apiUrl, token })
        setToken(''); setSettings(result); setNotice('NetBird connected. Load your devices to pair a companion.')
        await refresh()
        if (dialog === 'connection') closeSetup()
      }) }}>
      <div className="connect-field-with-help">
        <TextField variant={fieldVariant} label="NetBird API token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || !connected} />
        <SettingsHelp label="NetBird connection">Use a service-user API token with peer read access. Both computers must be on your NetBird network. The token is saved on the Suite host and is never included in chats.</SettingsHelp>
      </div>
      <Accordion items={[{ id: 'api-url', title: 'Advanced connection settings', content: <TextField variant={fieldVariant} label="NetBird API URL" value={apiUrl} onChange={event => setApiUrl(event.target.value)} disabled={busy || !connected} /> }]} />
      <Button type="submit" size="sm" disabled={!connected || busy || !token.trim()} loading={busy}>Save NetBird connection</Button>
    </form>

  const pairingForm = <div className="connect-pairing">
      <Accordion items={[{ id: 'companion-help', title: 'Companion setup', content: <div className="settings-detail-copy">
      <div className="connect-row">
        <Button variant="ghost" size="sm" disabled={busy} onPress={() => { void action(async () => {
          const response = await workspaceFetch('/api/connect/companion', { credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok) throw new Error('The Connect companion is unavailable on this server.')
          const url = URL.createObjectURL(await response.blob())
          const link = document.createElement('a'); link.href = url; link.download = 'aixand-connect.pyz'
          document.body.append(link); link.click(); link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 60000)
        }) }}><Icon name="arrow-down" />Download companion</Button>
        <SettingsHelp label="Pairing a device">Run the companion on the receiving computer and keep it open. Python 3.11 or newer is required. Choose the receiver below and enter its one-time code, which expires after ten minutes.</SettingsHelp>
      </div>
      <ol className="connect-setup">
        <li>Start the companion with the receiving computer’s NetBird IP and receiving folder:
          <pre>python aixand-connect.pyz --bind {peer?.ip ?? 'NETBIRD_IP'} --receive-dir "RECEIVING_FOLDER" --pair</pre></li>
        <li>On Windows, you can use <code>py -3</code> in place of <code>python</code>. Allow the Suite host to reach TCP port 47831 in NetBird and the device firewall.</li>
        <li>Keep the companion running while receiving files.</li>
      </ol>
      </div> }]} />
      <Button variant="secondary" disabled={busy || !connected} onPress={() => { void action(async () => {
        const result = await agents.request<{ peers: Peer[] }>('connect-peers'); setPeers(result.peers)
        if (!result.peers.length) setNotice('No supported IPv4 peers found in this NetBird account.')
      }) }}>Load NetBird devices</Button>
      <form className="connect-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
        const signature = JSON.stringify([peerId, name, port, code])
        if (pairing.current?.signature !== signature) pairing.current = { signature, key: requestId() }
        await agents.request('connect-pair', { key: pairing.current.key, peerId, name, port: Number(port), code: code.trim() })
        pairing.current = null; setCode(''); setNotice(`${name} paired.`); await refresh(); closeSetup()
      }) }}>
        <Select label="Receiving NetBird device" variant={fieldVariant} value={peerId} disabled={!connected || busy || !peers.length}
          options={peers.map((item) => ({ id: item.id, label: `${item.name} · ${item.ip}${item.connected ? '' : ' · offline'}`, disabled: !item.connected }))}
          onChange={(value) => { setPeerId(value); setName(peers.find((item) => item.id === value)?.name ?? '') }} />
        <TextField variant={fieldVariant} label="One-time pairing code" type="password" autoComplete="off" value={code} disabled={!connected || busy} onChange={(event) => setCode(event.target.value)} />
        <Accordion items={[{ id: 'pair-options', title: 'Pairing options', content: <div className="connect-form">
          <TextField variant={fieldVariant} label="Device name in Aixand" value={name} maxLength={128} disabled={!connected || busy} onChange={event => setName(event.target.value)} />
          <TextField variant={fieldVariant} label="Companion port" inputMode="numeric" value={port} disabled={!connected || busy} onChange={event => setPort(event.target.value)} />
        </div> }]} />
        <Button type="submit" size="sm" disabled={!connected || busy || !peer?.connected || !name.trim() || !/^[A-Za-z0-9_-]{43}$/.test(code.trim()) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535}>Pair device</Button>
      </form>
    </div>

  return <div className="connect-settings">
    <RemoteChatDialog open={Boolean(remoteDevice)} initialDevice={remoteDevice ?? ''} agents={agents}
      onOpenChange={value => { if (!value) setRemoteDevice(null) }}
      create={args => agents.request<ChatSnapshot>('chat-create', args)}
      onCreated={chat => { window.location.hash = `/chat/${chat.id}` }} />
    <Dialog open={active && dialog !== null} onOpenChange={open => { if (!open && !busy) closeSetup() }}
      className="connect-device-dialog" bodyClassName="settings-detail-copy" closeLabel="Close device setup"
      trigger={<Button hidden style={{ display: 'none' }}>Open device setup</Button>}
      title={showingConnection ? 'Connect NetBird' : 'Add device'}
      description={showingConnection ? 'Connect your NetBird network to add computers.' : 'Choose a computer and enter its companion’s pairing code.'}>
      {showingConnection ? connectionForm : pairingForm}
      {!connected && <p role="status">Reconnect to manage devices.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </Dialog>
    <div className="connect-device-section">
    <div className="connect-device-actions">
      <DropdownMenu label="Device actions"
        trigger={<Tooltip content="Device actions"><Button ref={menuTrigger} variant="ghost" size="sm" iconOnly aria-label="Device actions" disabled={!connected || busy || !settings}><Icon name="ellipsis" /></Button></Tooltip>}
        items={[{ id: 'pairing', label: 'Add device', leading: <Icon name="plus" /> },
          { id: 'connection', label: 'Connection settings', leading: <Icon name="settings" /> }]}
        onAction={id => {
          setError(''); setNotice('')
          requestAnimationFrame(() => setDialog(id === 'connection' ? 'connection' : 'pairing'))
        }} />
    </div>
    <SettingsSection className="settings-group" title="Devices" headingLevel={2}>
      {!connected && <p role="status">Reconnect to manage devices. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
      <div className="connect-devices" role="group" aria-label="Paired devices">
        {devices.map(device => <Disclosure className="connect-row-item connect-device-row" key={device.id}>
          <ListRow label={device.name} description={device.os || 'Paired computer'} leading={<Icon name="monitor" />}
            trailing={<div className="connect-row-actions">
              <Badge tone={device.status === 'ready' ? 'success' : device.status === 'offline' ? 'neutral' : 'warning'}>{device.status === 'ready' ? 'Ready to receive' : device.status === 'offline' ? 'Offline' : device.status === 'pairing-required' ? 'Pairing required' : 'Companion unavailable'}</Badge>
              {device.capabilities?.codex && <Tooltip content={`Start chat on ${device.name}`}><Button variant="ghost" size="sm" iconOnly aria-label={`Start chat on ${device.name}`} disabled={busy || !connected || device.status !== 'ready'} onPress={() => setRemoteDevice(device.id)}><Icon name="messages-square" /></Button></Tooltip>}
              <Button slot="trigger" variant="ghost" size="sm" iconOnly className="connect-details-trigger" aria-label={`Device details for ${device.name}`}><Icon name="chevron-down" /></Button>
            </div>} />
          {device.error && <p className="settings-note">{device.error}</p>}
          <DisclosurePanel className="connect-row-details">
            <dl className="connect-device-meta">
              <div><dt>Address</dt><dd>{device.ip}:{device.port}</dd></div>
              {device.receiveDir && <div><dt>Receiving folder</dt><dd><code>{device.receiveDir}</code></dd></div>}
            </dl>
            {!device.capabilities?.codex && <div className="connect-row"><span className="settings-note">Remote chats unavailable</span><SettingsHelp label="Remote chats">Update the companion and start it with --project-root "PROJECTS_FOLDER". Codex must be installed and signed in on that device.</SettingsHelp></div>}
            {device.capabilities?.managerDiscovery ? <Accordion items={[{ id: 'managers', title: 'Managers on this device', content: <div className="settings-detail-copy">
              <Button variant="secondary" size="sm" disabled={busy || !connected || device.status !== 'ready'} onPress={() => { void action(async () => {
                const result = await agents.request<DeviceManagers>('connect-managers-inspect', { deviceId: device.id })
                setManagers(current => ({ ...current, [device.id]: result }))
              }) }}>Check managers on {device.name}</Button>
              {managers[device.id] && <ManagerInventory value={managers[device.id]} />}
            </div> }]} /> : <div className="connect-row"><span className="settings-note">Manager discovery unavailable</span><SettingsHelp label="Manager discovery">Update the companion to discover optional managers on this device.</SettingsHelp></div>}
            {remove === device.id ? <div className="connect-row"><span>Remove this device from Suite?</span>
              <Button variant="danger" size="sm" disabled={busy || !connected} onPress={() => { void action(async () => {
                await agents.request('connect-forget', { deviceId: device.id }); setRemove(null); await refresh()
              }) }}>Remove device</Button><Button variant="ghost" size="sm" onPress={() => setRemove(null)}>Keep device</Button></div>
              : <Button variant="ghost" size="sm" disabled={busy || !connected} onPress={() => setRemove(device.id)}>Remove {device.name}</Button>}
          </DisclosurePanel>
        </Disclosure>)}
        {settings && !devices.length && <p className="settings-note">No devices paired yet.</p>}
      </div>
      {!dialog && error && <p role="alert">{error}</p>}
      {!dialog && notice && <p role="status">{notice}</p>}
    </SettingsSection>
    </div>
    <BackgroundWork agents={agents} devices={devices} />
  </div>
}
