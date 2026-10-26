import { Button, Checkbox, Icon, SearchField, Tooltip, type IconName } from 'bbb-design'
import { useRef, useState } from 'react'
import type { Provider, ProviderInfo } from '../agents/client'
import { providerUsable, setupName, type SetupProvider } from './agentSetup'

const providerIcons: Record<SetupProvider, IconName> = {
  codex: 'square-terminal', opencode: 'layers', claude: 'sparkles', antigravity: 'orbit', copilot: 'bot',
}

export function AgentProviderPicker({ providers, selected, disabled, refreshing, pending = [], onSelectionChange, onRefresh, onContinue }: {
  providers: ProviderInfo[]
  selected: SetupProvider[]
  disabled: boolean
  refreshing: boolean
  pending?: Provider[]
  onSelectionChange: (selected: SetupProvider[]) => void
  onRefresh: () => void
  onContinue: () => void
}) {
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const search = query.trim().toLocaleLowerCase()
  const setupProviders = providers.map(row => row.provider)
  const visible = setupProviders.filter(id => `${setupName(id, { providers })} ${id}`.toLocaleLowerCase().includes(search))
  const selectionLabel = selected.length === 1 ? '1 agent selected' : `${selected.length} agents selected`

  return <div className="setup-provider-picker">
    <div className="setup-picker-search">
      <SearchField ref={searchInput} label="Search agents" placeholder="Search agents…" value={query} onChange={setQuery}
        clearLabel="Clear agent search" />
      <Tooltip content="Refresh agents"><Button variant="ghost" iconOnly aria-label="Refresh detection" disabled={disabled} loading={refreshing} onPress={onRefresh}>
        <Icon name="refresh-cw" />
      </Button></Tooltip>
    </div>
    <p className="bbb-visually-hidden" role="status">{search ? `${visible.length} matching ${visible.length === 1 ? 'agent' : 'agents'}` : `${setupProviders.length} available agents`}</p>
    <div className="setup-providers" role="region" aria-label="Available agents" tabIndex={0} aria-busy={refreshing}>
      {visible.length ? <ul className="setup-provider-list">{visible.map(id => {
        const info = providers.find(row => row.provider === id)
        const installed = providerUsable(info)
        const status = info?.available === false ? 'Unavailable' : installed ? 'Installed' : info?.installed ? 'Check setup' : 'Needs installation'
        return <li className="setup-provider" key={id} data-selected={selected.includes(id)}>
          <span className="setup-provider-symbol" aria-hidden="true"><Icon name={providerIcons[id] ?? 'bot'} /></span>
          <Checkbox className="setup-provider-choice" label={setupName(id, { providers })}
            isSelected={selected.includes(id)} disabled={disabled || pending.includes(id) || info?.available === false} aria-describedby={`setup-provider-status-${id}`}
            onChange={checked => onSelectionChange(checked
              ? setupProviders.filter(value => value === id || selected.includes(value))
              : selected.filter(value => value !== id))} />
          <span className="setup-provider-status" id={`setup-provider-status-${id}`} data-installed={installed}
            title={installed && info?.version ? `Installed · ${info.version}` : undefined}>
            {installed && <Icon name="check" />}{status}
          </span>
        </li>
      })}</ul> : <div className="setup-provider-empty">
        <Icon name="search" />
        <strong>No agents found</strong>
        <p>Try another name or clear your search to see all agents.</p>
        <Button variant="ghost" size="sm" onPress={() => { setQuery(''); searchInput.current?.focus() }}>Clear search</Button>
      </div>}
    </div>
    <div className="setup-picker-footer">
      <div className="setup-picker-summary">
        <p className="setup-selection-count" role="status">{selectionLabel}</p>
        {!selected.length && <p className="setup-picker-hint">Select an agent to continue.</p>}
      </div>
      <Button disabled={disabled || selected.length === 0} onPress={onContinue}>
        Continue
        <Icon name="arrow-right" />
      </Button>
    </div>
  </div>
}
