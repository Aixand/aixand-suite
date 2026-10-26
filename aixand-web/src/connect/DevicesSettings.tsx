import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Select, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { requestId } from '../terminals/connection'
import type { ConnectStatus, Device, Peer, DeviceManagers } from './model'
import './connect.css'
import { ManagerInventory } from './ManagerInventory'
import { RemoteChatDialog } from './RemoteChatDialog'
import type { ChatSnapshot } from '../chats/model'
import { BackgroundWork } from './BackgroundWork'

export function DevicesSettings({ agents }: { agents: AgentsModel }) {
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
  const pairing = useRef<{ signature: string; key: string } | null>(null)
  const connected = agents.status === 'connected'

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
  const peer = peers.find((item) => item.id === peerId)
  return <Card as="section" className="ws-panel connect-settings" title="Devices" headingLevel={2}>
    <RemoteChatDialog open={Boolean(remoteDevice)} initialDevice={remoteDevice ?? ''} agents={agents}
      onOpenChange={(value) => { if (!value) setRemoteDevice(null) }}
      create={(args) => agents.request<ChatSnapshot>('chat-create', args)}
      onCreated={(chat) => { window.location.hash = `/chat/${chat.id}` }} />
    <p>Send files and start Codex chats on paired computers. The Suite host and connected devices must be on your NetBird network.</p>
    {!connected && <p role="status">Reconnect to manage devices. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    <details open={!settings?.configured}>
      <summary>{settings?.configured ? 'NetBird connection settings' : 'Connect NetBird'}</summary>
      <form className="connect-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
        const result = await agents.request<ConnectStatus>('connect-configure', { apiUrl, token })
        setToken(''); setSettings(result); setNotice('NetBird connected. Load your devices to pair a companion.')
        await refresh()
      }) }}>
        <TextField label="NetBird API URL" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} disabled={busy || !connected} />
        <TextField label="NetBird API token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || !connected} />
        <p className="settings-help">Use a service-user API token with peer read access. It is saved on the Suite host and is never included in chats.</p>
        <Button type="submit" disabled={!connected || busy || !token.trim()} loading={busy}>Save NetBird connection</Button>
      </form>
    </details>
    <div className="connect-devices" role="group" aria-label="Paired devices">
      {devices.map((device) => <article className="connect-device" key={device.id}>
        <div className="connect-row"><strong>{device.name}</strong><Badge>{device.status === 'ready' ? 'Ready to receive' : device.status === 'offline' ? 'Offline' : device.status === 'pairing-required' ? 'Pairing required' : 'Companion unavailable'}</Badge></div>
        <p>{device.os || 'Device'} · {device.ip}:{device.port}</p>
        {device.receiveDir && <p className="connect-path">Receiving folder: <code>{device.receiveDir}</code></p>}
        {device.error && <p>{device.error}</p>}
        {device.capabilities?.codex ? <Button variant="secondary" disabled={busy || !connected || device.status !== 'ready'} onPress={() => setRemoteDevice(device.id)}>Start chat on {device.name}</Button>
          : <p className="settings-help">To enable remote chats, update the companion and add <code>--project-root "PROJECTS_FOLDER"</code> when starting it. Codex must be installed and signed in on that device.</p>}
        {device.capabilities?.managerDiscovery ? <details>
          <summary>Managers on this device</summary>
          <Button variant="secondary" disabled={busy || !connected || device.status !== 'ready'} onPress={() => { void action(async () => {
            const result = await agents.request<DeviceManagers>('connect-managers-inspect', { deviceId: device.id })
            setManagers((current) => ({ ...current, [device.id]: result }))
          }) }}>Check managers on {device.name}</Button>
          {managers[device.id] && <ManagerInventory value={managers[device.id]} />}
        </details> : <p className="settings-help">Update the companion to discover optional managers on this device.</p>}
        {remove === device.id ? <div className="connect-row"><span>Remove this device from Suite?</span>
          <Button variant="secondary" disabled={busy || !connected} onPress={() => { void action(async () => {
            await agents.request('connect-forget', { deviceId: device.id }); setRemove(null); await refresh()
          }) }}>Remove device</Button><Button variant="ghost" onPress={() => setRemove(null)}>Keep device</Button></div>
          : <Button variant="ghost" disabled={busy || !connected} onPress={() => setRemove(device.id)}>Remove {device.name}</Button>}
      </article>)}
      {settings?.configured && !devices.length && <p>No devices paired yet.</p>}
    </div>
    {settings?.configured && <details>
      <summary>Pair a device</summary>
      <ol className="connect-setup">
        <li>On the receiving computer, download the <a href="/downloads/aixand-connect.pyz" download>Aixand Connect companion</a>. Python 3.11 or newer is required.</li>
        <li>Start it with that computer’s NetBird IP and receiving folder. Keep it running while receiving files.
          <pre>python aixand-connect.pyz --bind {peer?.ip ?? 'NETBIRD_IP'} --receive-dir "RECEIVING_FOLDER" --pair</pre>
          <span>On Windows you can use <code>py -3</code> in place of <code>python</code>. Allow the Suite host to reach TCP port 47831 in NetBird and the device firewall.</span></li>
        <li>Load your NetBird devices, select the receiver, and enter the pairing code displayed there. The code expires after ten minutes.</li>
      </ol>
      <Button variant="secondary" disabled={busy || !connected} onPress={() => { void action(async () => {
        const result = await agents.request<{ peers: Peer[] }>('connect-peers'); setPeers(result.peers)
        if (!result.peers.length) setNotice('No supported IPv4 peers found in this NetBird account.')
      }) }}>Load NetBird devices</Button>
      <form className="connect-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
        const signature = JSON.stringify([peerId, name, port, code])
        if (pairing.current?.signature !== signature) pairing.current = { signature, key: requestId() }
        await agents.request('connect-pair', { key: pairing.current.key, peerId, name, port: Number(port), code: code.trim() })
        pairing.current = null; setCode(''); setNotice(`${name} paired. Ask a project chat to send a file to this device.`); await refresh()
      }) }}>
        <Select label="Receiving NetBird device" variant="outlined" value={peerId} disabled={!connected || busy || !peers.length}
          options={peers.map((item) => ({ id: item.id, label: `${item.name} · ${item.ip}${item.connected ? '' : ' · offline'}`, disabled: !item.connected }))}
          onChange={(value) => { setPeerId(value); setName(peers.find((item) => item.id === value)?.name ?? '') }} />
        <TextField label="Device name in Aixand" value={name} maxLength={128} disabled={!connected || busy} onChange={(event) => setName(event.target.value)} />
        <TextField label="Companion port" inputMode="numeric" value={port} disabled={!connected || busy} onChange={(event) => setPort(event.target.value)} />
        <TextField label="One-time pairing code" type="password" autoComplete="off" value={code} disabled={!connected || busy} onChange={(event) => setCode(event.target.value)} />
        <Button type="submit" disabled={!connected || busy || !peer?.connected || !name.trim() || !/^[A-Za-z0-9_-]{43}$/.test(code.trim()) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535}>Pair device</Button>
      </form>
    </details>}
    <BackgroundWork agents={agents} devices={devices} />
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </Card>
}
