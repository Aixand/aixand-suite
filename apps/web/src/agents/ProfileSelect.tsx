import type { ComponentProps } from 'react'
import { Combobox, Select } from 'bbb-design'

/** Small lists stay simple; larger account and model inventories are searchable. */
export function ProfileSelect({ options, value, onChange, label, hideLabel, disabled, variant, className = '' }: Pick<ComponentProps<typeof Select>,
  'options' | 'value' | 'onChange' | 'label' | 'hideLabel' | 'disabled' | 'variant' | 'className'>) {
  if (options.length < 9) return <Select label={label} hideLabel={hideLabel} options={options} value={value}
    onChange={onChange} disabled={disabled} variant={variant} className={className} />
  return <Combobox label={label} options={options} selectedKey={value ?? null}
    onSelectionChange={key => { if (key !== null) onChange?.(String(key)) }} disabled={disabled} variant={variant}
    className={`agent-profile-select${hideLabel ? ' agent-profile-select-hidden-label' : ''} ${className}`} />
}
