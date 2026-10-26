import type { ReactNode } from 'react'
import { Button, Icon, Tooltip, useThemeAttributes, type SelectOption } from 'bbb-design'
import { Dialog, DialogTrigger, Heading, ListBox, ListBoxItem, Popover } from 'react-aria-components'

export function ChatModelPicker({ value, options, displayValue, summary, notice, disabled, modelDisabled, open, onOpenChange, onChange, children }: {
  value: string
  options: SelectOption[]
  displayValue?: string
  summary: string
  notice?: string
  disabled: boolean
  modelDisabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
  children: ReactNode
}) {
  const theme = useThemeAttributes()
  const label = displayValue ?? options.find(option => option.id === value)?.label ?? (value || 'Profile default')
  return <div className="command-context-picker command-context-picker--model">
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Tooltip content={`Model: ${label}${summary}`} className="command-picker-tooltip">
        <Button variant="ghost" size="sm" className="command-context-button command-model-button"
          aria-label={`${label}${summary} Model`} disabled={disabled}>
          <span className="command-model-value">
            <span className="command-model-name">{label}</span>
            {summary && <span className="command-model-summary">{summary}</span>}
          </span>
          {!disabled && <Icon name="chevron-down" className="command-picker-chevron" />}
        </Button>
      </Tooltip>
      <Popover {...theme} placement="top start" className="bbb-theme bbb-floating-surface command-model-settings-popover">
        <Dialog className="command-model-settings">
          {({ close }) => <>
            <Heading slot="title">Model settings</Heading>
            <div className="command-model-settings-body">
              <div>
                <p className="command-context-options-label">Model</p>
                <ListBox aria-label="Model" className="bbb-option-list command-model-options" items={options}
                  selectionMode="single" selectionBehavior="toggle" disallowEmptySelection selectedKeys={[value]}
                  disabledKeys={options.filter(option => modelDisabled || option.disabled).map(option => option.id)}
                  onSelectionChange={keys => {
                    if (modelDisabled || keys === 'all') return
                    const selected = keys.values().next().value
                    if (selected !== undefined && String(selected) !== value) onChange(String(selected))
                  }}>
                  {option => <ListBoxItem id={option.id} textValue={option.label} className="bbb-option">
                    {({ isSelected }) => <>
                      <span className="bbb-option__content">
                        <span>{option.label}{option.description && <span className="bbb-option__description">{option.description}</span>}</span>
                      </span>
                      {isSelected && <Icon name="check" />}
                    </>}
                  </ListBoxItem>}
                </ListBox>
              </div>
              {children}
              {notice && <p className="chat-settings-note" role="status">{notice}</p>}
            </div>
            <Button size="sm" variant="secondary" onPress={close}>Done</Button>
          </>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  </div>
}
