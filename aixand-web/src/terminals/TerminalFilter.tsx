import { Button, DropdownSurface, Icon, Tooltip } from 'bbb-design'
import { Menu, MenuItem, MenuTrigger } from 'react-aria-components'
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider'

export function TerminalFilter({ value, options, onChange }: {
  value: string
  options: { id: string; label: string }[]
  onChange: (value: string) => void
}) {
  const selected = options.find(option => option.id === value)?.label ?? 'All terminals'
  return <UNSAFE_PortalProvider getContainer={() => document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.body}>
    <MenuTrigger>
      <Tooltip content={`Filter terminals: ${selected}`}><Button variant="ghost" size="sm" iconOnly
        className="tw-filter-trigger" data-filtered={value !== '@all' || undefined}
        aria-label={`Filter terminals: ${selected}`}><Icon name="layers" /></Button></Tooltip>
      <DropdownSurface className="bbb-dropdown-menu tw-filter-menu" placement="bottom end">
        <Menu aria-label="Filter by group or context" className="bbb-option-list" items={options}
          selectionMode="single" disallowEmptySelection selectedKeys={[value]} onAction={id => onChange(String(id))}>
          {option => <MenuItem id={option.id} textValue={option.label} className="bbb-option">
            {({ isSelected }) => <><span>{option.label}</span>{isSelected && <Icon name="check" />}</>}
          </MenuItem>}
        </Menu>
      </DropdownSurface>
    </MenuTrigger>
  </UNSAFE_PortalProvider>
}
