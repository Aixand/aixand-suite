import type { DeviceManagers } from './model'

const names: Record<string, string> = { agent: 'Agent Manager', conversation: 'Conversation Manager', mcp: 'MCP Manager',
  prompt: 'Prompt Manager', skill: 'Skill Manager', undercurrent: 'Undercurrent SDK' }

export function ManagerInventory({ value }: { value: DeviceManagers }) {
  return <div className="connect-manager-inventory">
    <p>{value.managedCodex ? 'Managed Codex available' : 'Managed Codex not ready'}</p>
    <ul>{Object.entries(names).map(([key, label]) => {
      const item = value.packages[key]
      return <li key={key}>{label}: {item?.installed ? `Installed${item.version ? ` · ${item.version}` : ''}${item.separateEnvironment ? ' · separate environment' : ''}${item.configured === true ? ' · configured' : item.configured === false ? ' · no saved configuration' : ''}${item.usable === false ? ' · dependencies unavailable' : ''}` : 'Not detected'}</li>
    })}</ul>
    {Object.entries(value.resourceIntegrations ?? {}).filter(([, item]) => !item.available).map(([kind, item]) =>
      <p key={kind}>{item.reason?.message ?? `${item.manager} is unavailable on this device.`}</p>)}
    <p>{value.runtime.kind === 'conversation-worker' ? 'Conversation worker support' : 'Undercurrent runtime'}: {value.runtime.ready ? 'Available' : 'Unavailable'}</p>
    {!!value.profiles.length && <p>Device profiles: {value.profiles.map((profile) => profile.profile).join(', ')}</p>}
    {value.reason && <p>{value.reason}</p>}
    <p className="settings-help">Installed packages and configured profiles are inspected on this device. Login and session capabilities are checked when starting a managed chat.</p>
  </div>
}
