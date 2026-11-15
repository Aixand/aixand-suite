import { useContext, useRef } from 'react'
import { Button, Icon, useThemeAttributes } from 'bbb-design'
import { ComboBox, ComboBoxStateContext, Group, Input, Label, ListBox, ListBoxItem, Popover, Text } from 'react-aria-components'

export function ProjectFolderLocation({ value, current, suggestions, error, autoFocus, onCancel, onChange, onNavigate }: {
  value: string
  current: string
  suggestions: string[]
  error: string
  autoFocus?: boolean
  onCancel: () => void
  onChange: (value: string) => void
  onNavigate: (path: string) => void
}) {
  const theme = useThemeAttributes()
  const field = useRef<HTMLDivElement>(null)
  const options = [...new Set([...(value === current ? [current] : []), ...suggestions])].map(path => ({ id: path }))
  return <ComboBox className="bbb-field bbb-combobox" inputValue={value} selectedKey={value === current ? current : null}
    items={options} allowsCustomValue allowsEmptyCollection menuTrigger="input" isInvalid={!!error}
    onInputChange={onChange} onSelectionChange={key => { if (key !== null) onNavigate(String(key)) }}>
    <Label className="bbb-visually-hidden">Folder location</Label>
    <div ref={field} className="bbb-field__surface" data-variant="outlined" data-invalid={!!error || undefined}>
      <Group className="bbb-field__control" data-invalid={!!error || undefined}>
        <LocationInput autoFocus={autoFocus} onCancel={onCancel} onNavigate={() => onNavigate(value)} />
        <Button variant="ghost" iconOnly aria-label="Show folder suggestions"><Icon name="chevron-down" /></Button>
      </Group>
    </div>
    {error && <Text slot="description" className="bbb-field__message bbb-field__message--error">{error}</Text>}
    <Popover {...theme} triggerRef={field} placement="bottom start" isNonModal
      className="bbb-theme bbb-floating-surface bbb-dropdown-surface project-folder-suggestions">
      <section aria-label="Folder suggestions">
      <ListBox<{ id: string }> className="bbb-option-list" aria-label="Folder suggestions"
        renderEmptyState={() => <span className="bbb-option-list__empty">No matching folders.</span>}>
        {option => <ListBoxItem id={option.id} textValue={option.id} className="bbb-option">
          <span className="project-folder-suggestion"><Icon name="folder" /><span>{option.id}</span></span>
        </ListBoxItem>}
      </ListBox>
      </section>
    </Popover>
  </ComboBox>
}

function LocationInput({ autoFocus, onCancel, onNavigate }: { autoFocus?: boolean; onCancel: () => void; onNavigate: () => void }) {
  const state = useContext(ComboBoxStateContext)
  return <Input autoFocus={autoFocus} placeholder="Type a path, like /home/" onKeyDown={event => {
    if (event.key === 'Escape' && !state?.isOpen) {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    if (event.key === 'Enter' && (!state?.isOpen || state.selectionManager.focusedKey === null)) {
      event.preventDefault()
      state?.close()
      onNavigate()
    }
  }} />
}
