import { Button, Icon } from 'bbb-design'
import { agentSections } from './routes'
import type { AgentSection } from './routes'

export function AgentNavigation({ section, counts, disabled, onSelect, close }: {
  section: AgentSection; counts: Partial<Record<AgentSection, number>>; disabled: boolean
  onSelect: (section: AgentSection) => void; close: () => void
}) {
  const buttons = (group: typeof agentSections[number]['group']) => agentSections.filter(item => item.group === group).map(item => <Button key={item.id}
    variant="ghost" className="carrier-folder" aria-pressed={section === item.id} disabled={disabled}
    onPress={() => { close(); onSelect(item.id) }}>
    <Icon name={item.icon} /><span>{item.label}</span>{!!counts[item.id] && <span className="carrier-folder-count">{counts[item.id]}</span>}
  </Button>)
  return <div className="carrier-navigation agent-navigation">
    <div className="carrier-mailbox"><strong>Agents</strong><span>Sessions and configuration</span></div>
    <div className="carrier-folders" role="group" aria-label="Agent sections">{buttons('work')}</div>
    {(['configuration', 'setup'] as const).map(group => <div className="agent-navigation-group" key={group}>
      <p className="agent-navigation-label">{group === 'configuration' ? 'Library' : 'Setup'}</p>
      <div className="carrier-folders" role="group" aria-label={group === 'configuration' ? 'Agent library' : 'Agent setup'}>{buttons(group)}</div>
    </div>)}
    <div className="carrier-folders agent-navigation-utility" role="group" aria-label="Agent utilities">{buttons('utility')}</div>
  </div>
}
