import { Fragment } from 'react'
import { Button, Icon } from 'bbb-design'
import { WorkspaceSidebarBody, WorkspaceSidebarHeader } from '../components/WorkspaceSidebar'
import { agentSections } from './routes'
import type { AgentSection } from './routes'
import type { WorkspacePanes } from './AgentWorkspace'

export function AgentNavigation({ section, counts, disabled, onSelect, close, subnavigation }: {
  section: AgentSection; counts: Partial<Record<AgentSection, number>>; disabled: boolean
  onSelect: (section: AgentSection) => void; close: () => void
  subnavigation?: WorkspacePanes['subnavigation']
}) {
  const buttons = (group: typeof agentSections[number]['group']) => agentSections.filter(item => item.group === group).map(item => <Fragment key={item.id}><Button
    variant="ghost" className="workspace-sidebar__item" aria-pressed={section === item.id} disabled={disabled}
    onPress={() => { close(); onSelect(item.id) }}>
    <Icon name={item.icon} /><span>{item.label}</span>{!!counts[item.id] && <span className="workspace-sidebar__count">{counts[item.id]}</span>}
  </Button>
    {section === item.id && subnavigation && <div className="agent-subnavigation" role="group" aria-label={subnavigation.label}>
      {subnavigation.items.map(link => <Button key={link.id} variant="ghost" size="sm" aria-current={subnavigation.selected === link.id ? 'page' : undefined}
        disabled={disabled} onPress={() => { close(); subnavigation.onSelect(link.id) }}>{link.label}</Button>)}
    </div>}
  </Fragment>)
  return <>
    <WorkspaceSidebarHeader title="Agents" />
    <WorkspaceSidebarBody className="workspace-sidebar__navigation agent-navigation">
      <div className="workspace-sidebar__group" role="group" aria-label="Agent sections">{buttons('work')}</div>
      {(['configuration', 'setup'] as const).map(group => <div className="agent-navigation-group" key={group}>
        <h3 className="workspace-sidebar__section-heading">{group === 'configuration' ? 'Library' : 'Setup'}</h3>
        <div className="workspace-sidebar__group" role="group" aria-label={group === 'configuration' ? 'Agent library' : 'Agent setup'}>{buttons(group)}</div>
      </div>)}
      <div className="workspace-sidebar__group agent-navigation-utility" role="group" aria-label="Agent utilities">{buttons('utility')}</div>
    </WorkspaceSidebarBody>
  </>
}
