import { useEffect, useState, type ReactNode } from 'react'
import { Button, Icon, SearchField, Tooltip, useThemeAttributes, type SelectOption } from 'bbb-design'
import { Dialog, DialogTrigger, Heading, ListBox, ListBoxItem, Popover, Text } from 'react-aria-components'
import { ReasoningSlider, type ResponseSettings } from './ChatResponseSettings'
import { configOptions } from './commands'

export function ChatModelPicker({ value, options, displayValue, summary, disabled, modelDisabled, open, onOpenChange, onChange, responseSettings, controls, refresh, footer, children }: {
  value: string
  options: SelectOption[]
  displayValue?: string
  summary: string
  disabled: boolean
  modelDisabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void | Promise<void>
  responseSettings?: ResponseSettings
  children: ReactNode
  refresh?: ReactNode
  footer?: ReactNode
  controls?: ReactNode
}) {
  const theme = useThemeAttributes()
  const [query, setQuery] = useState('')
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const effort = responseSettings?.effort
  const hasReasoning = Boolean(effort?.type === 'select' && configOptions(effort).length)

  useEffect(() => {
    if (!open) { setQuery(''); setReasoningOpen(false) }
  }, [open])
  const reasoningValue = effort?.defaultUnknown ? 'Provider default' :
    (effort && configOptions(effort).find(choice => choice.value === effort.currentValue)?.name) ?? 'Provider default'
  const search = query.trim().toLowerCase()
  const filteredOptions = options.filter(option => !search || `${option.label} ${option.id} ${option.description ?? ''}`.toLowerCase().includes(search))
  const label = displayValue ?? options.find(option => option.id === value)?.label ?? (value || 'Default')
  return <div className="command-context-picker command-context-picker--model">
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Tooltip content={`Model: ${label}${summary}${!value && displayValue ? ' · Default' : ''}`} className="command-picker-tooltip">
        <Button variant="ghost" size="sm" className="command-context-button command-model-button"
          aria-label={`${label}${summary} Model`} disabled={disabled}>
          <span className="command-model-name">{value ? label : 'Default'}</span>
          <Icon name="chevron-down" className="command-picker-chevron" />
        </Button>
      </Tooltip>
      <Popover {...theme} placement="top start" className="bbb-theme bbb-floating-surface command-model-settings-popover">
        <Dialog className="command-model-settings">
          {({ close }) => <>
            <div className="command-model-settings-header"><Heading slot="title">Choose model</Heading>{refresh}</div>
            <div className="command-model-settings-body">
              {controls}
              <div>
                {options.length > 8 && <SearchField label="Search models" placeholder="Search models…" value={query} onChange={setQuery} />}
                <ListBox aria-label="Model" className="bbb-option-list command-model-options" items={filteredOptions}
                  dependencies={[value, modelDisabled, onChange]}
                  selectionMode="single" selectionBehavior="toggle" disallowEmptySelection selectedKeys={[value]} shouldFocusOnHover
                  disabledKeys={options.filter(option => option.disabled || modelDisabled).map(option => option.id)}
                  renderEmptyState={() => <span className="bbb-option-list__empty">{search ? 'No models match your search.' : 'No models available.'}</span>}>
                  {option => <ListBoxItem id={option.id} textValue={option.label} className="bbb-option"
                    onPress={async () => {
                    if (option.disabled) return
                    if (modelDisabled) return
                    if (option.id !== value) await onChange(option.id)
                    close()
                  }}>
                    {({ isSelected }) => <>
                      <span className="bbb-option__content"><Text slot="label">{option.label}</Text>
                        {option.id === '' && <Text slot="description" className="bbb-option__description">Use the profile’s model</Text>}
                      </span>
                      {isSelected && <Icon name="check" />}
                    </>}
                  </ListBoxItem>}
                </ListBox>
              </div>
              {hasReasoning && responseSettings && <div className="command-model-reasoning">
                <Button size="sm" variant="ghost" disabled={responseSettings.disabled} aria-expanded={reasoningOpen}
                  onPress={() => setReasoningOpen(current => !current)}>
                  Reasoning: {reasoningValue}<Icon name={reasoningOpen ? 'chevron-down' : 'chevron-right'} />
                </Button>
                {reasoningOpen && <ReasoningSlider option={effort!} disabled={responseSettings.disabled} onChange={responseSettings.onChange} />}
              </div>}
              {children}
            </div>
            {footer && <div className="command-model-settings-footer">{footer}</div>}
          </>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  </div>
}
