import { Button, Card, PageHeader, Switch } from 'bbb-design'
import { setDebugMode, useSettings } from './model'
import './settings.css'
import type { AgentsModel } from '../agents/model'
import { SpawnSettings } from './SpawnSettings'
import { ApprovalSettings } from './ApprovalSettings'
import { DevicesSettings } from '../connect/DevicesSettings'
import { ResetSettings } from './ResetSettings'

const sections = [{ id: 'agents', label: 'Agent behavior' }, { id: 'devices', label: 'Devices' },
  { id: 'troubleshooting', label: 'Troubleshooting' }, { id: 'data', label: 'Data management' }]

export function SettingsPage({ agents, route = 'settings', navigate = value => { window.location.hash = '/' + value } }: { agents: AgentsModel; route?: string; navigate?: (route: string) => void }) {
  const requested = new URLSearchParams(route.split('?')[1]).get('section')
  const section = sections.find(item => item.id === requested)?.id ?? 'agents'
  const settings = useSettings()
  return <div className="ws-page settings-page settings-page--sections">
    <PageHeader className="ws-heading" title="Settings"
      description="Agent defaults and browser preferences." />
    {settings.storageError && <p role="alert">{settings.storageError}</p>}
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="Settings sections">{sections.map(item => <Button key={item.id} variant="ghost"
        aria-current={section === item.id ? 'page' : undefined} onPress={() => navigate(`settings?section=${item.id}`)}>{item.label}</Button>)}</nav>
      <div className="settings-sections">
    <div className="settings-panel" hidden={section !== 'agents'}>
    <SpawnSettings agents={agents} />
    <ApprovalSettings agents={agents} />
    </div><div className="settings-panel" hidden={section !== 'devices'}>
    <DevicesSettings agents={agents} />
    </div><div className="settings-panel" hidden={section !== 'troubleshooting'}>
    <Card as="section" className="ws-panel settings-debug" title="Troubleshooting" headingLevel={2}>
      <Switch label="Debug mode" checked={settings.debugMode}
        onChange={(event) => setDebugMode(event.target.checked)}
        description="Enable Vox console logs and diagnostic reports. Turning this off stops collection and clears the stored report." />
      <p className="settings-help">Debug mode is off by default. Reports stay in memory and are shared only when you copy them.</p>
      <p className="settings-limits">Vox keeps up to 200 recent events in a 128 KB buffer. Copied reports are limited to 256 KB, and console output is capped at 200 messages per page visit.</p>
    </Card>
    </div><div className="settings-panel" hidden={section !== 'data'}>
    <ResetSettings agents={agents} />
    </div></div></div>
  </div>
}
