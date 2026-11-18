import { useCapabilities } from '../capabilities'
import { Button, ListRow, PageHeader, SettingsSection, Switch } from 'bbb-design'
import { useEffect, useRef, useState } from 'react'
import { setDebugMode, useSettings } from './model'
import './settings.css'
import type { AgentsModel } from '../agents/model'
import { SpawnSettings } from './SpawnSettings'
import { CodexServerSettings } from './CodexServerSettings'
import { ApprovalSettings } from './ApprovalSettings'
import { DevicesSettings } from '../connect/DevicesSettings'
import { ResetSettings } from './ResetSettings'
import { SettingsHelp } from './SettingsHelp'
import { UpdatesSettings } from './UpdatesSettings'
import { InstructionDefaults } from './InstructionDefaults'

const allSettingsSections = [{ id: 'workspace', label: 'Workspace setup' }, { id: 'agents', label: 'Agent behavior' }, { id: 'devices', label: 'Devices' },
  { id: 'updates', label: 'Updates' }, { id: 'troubleshooting', label: 'Troubleshooting' }, { id: 'data', label: 'Data management' }]

export function settingsSections(voice: boolean) {
  return allSettingsSections.filter(section => voice || section.id !== 'troubleshooting')
}

export function SettingsPage({ agents, onSetup, route = 'settings', navigate = value => { window.location.hash = '/' + value } }: {
  agents: AgentsModel; onSetup: () => Promise<void>; route?: string; navigate?: (route: string) => void
}) {
  const { voice } = useCapabilities()
  const sections = settingsSections(voice)
  const requested = new URLSearchParams(route.split('?')[1]).get('section')
  const section = sections.find(item => item.id === requested)?.id ?? 'agents'
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    const revealSection = () => {
      const nav = navigation.current
      const selected = nav?.querySelector<HTMLElement>('[aria-current="page"]')
      if (!nav || !selected || nav.scrollWidth <= nav.clientWidth) return
      nav.scrollTo({ left: nav.scrollLeft + selected.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - selected.offsetWidth) / 2 })
    }
    revealSection()
    window.addEventListener('resize', revealSection)
    return () => window.removeEventListener('resize', revealSection)
  }, [section])
  const settings = useSettings()
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  async function openSetup() {
    if (setupBusy) return
    setSetupBusy(true); setSetupError('')
    try { await onSetup() }
    catch (cause) { setSetupError(cause instanceof Error ? cause.message : 'Could not open workspace setup. Try again.') }
    finally { setSetupBusy(false) }
  }
  return <div className="ws-page settings-page settings-page--sections">
    <PageHeader className="ws-heading" title="Settings"
      description="Workspace setup, agent defaults, and browser preferences." />
    {settings.storageError && <p role="alert">{settings.storageError}</p>}
    <div className="settings-layout">
      <nav ref={navigation} className="settings-navigation" aria-label="Settings sections">{sections.map(item => <Button key={item.id} variant="ghost"
        aria-current={section === item.id ? 'page' : undefined} onPress={() => navigate(`settings?section=${item.id}`)}>{item.label}</Button>)}</nav>
      <div className="settings-sections">
    <div className="settings-panel" hidden={section !== 'workspace'}>
    <SettingsSection className="settings-group" title="Workspace setup" headingLevel={2}>
      <ListRow label="Agents and projects" description="Connect accounts and resume unfinished setup."
        trailing={<Button onPress={() => void openSetup()} loading={setupBusy} disabled={setupBusy}>Set up workspace</Button>} />
      {setupError && <p role="alert">{setupError}</p>}
    </SettingsSection>
    </div>
    {section === 'updates' && <div className="settings-panel"><UpdatesSettings /></div>}
    <div className="settings-panel" hidden={section !== 'agents'}>
    <SettingsSection className="settings-group" title="Agent behavior" headingLevel={2}>
      <SpawnSettings agents={agents} />
      <CodexServerSettings agents={agents} />
      <ApprovalSettings agents={agents} />
      <InstructionDefaults agents={agents} />
    </SettingsSection>
    </div><div className="settings-panel" hidden={section !== 'devices'}>
    <DevicesSettings agents={agents} active={section === 'devices'} />
    </div>{voice && <div className="settings-panel" hidden={section !== 'troubleshooting'}>
    <SettingsSection className="settings-group settings-debug" title="Troubleshooting" headingLevel={2}>
      <div className="settings-switch-row">
      <Switch label="Debug mode" checked={settings.debugMode}
        onChange={(event) => setDebugMode(event.target.checked)}
        description="Collect Vox logs and diagnostic reports." />
      <SettingsHelp label="Debug mode">Logs stay in memory and are shared only when copied. Turning this off clears them. Limits: 200 recent events, 128 KB in memory, 256 KB per report, and 200 console messages per visit.</SettingsHelp>
      </div>
    </SettingsSection>
    </div>}<div className="settings-panel" hidden={section !== 'data'}>
    <ResetSettings agents={agents} />
    </div></div></div>
  </div>
}
