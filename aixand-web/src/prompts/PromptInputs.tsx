import { useState } from 'react'
import {
  Button,
  Checkbox,
  NumberField,
  Select,
  Textarea,
  TextField,
} from 'bbb-design'
import type { InputContract } from './model'
import { parseInputs } from './presentation'

export function PromptInputs({
  contracts,
  value,
  onChange,
  disabled,
  label,
}: {
  contracts: Record<string, InputContract>
  value: string
  onChange: (value: string) => void
  disabled: boolean
  label: string
}) {
  const simple = Object.values(contracts).every(
    (spec) =>
      spec.enum ||
      ['string', 'boolean', 'integer', 'number'].includes(spec.type),
  )
  const [json, setJson] = useState(!simple)
  let parsed: Record<string, unknown> = {}
  let valid = true
  try {
    parsed = parseInputs(value)
  } catch {
    valid = false
  }
  const update = (key: string, next: unknown) =>
    onChange(JSON.stringify({ ...parsed, [key]: next }, null, 2))

  return (
    <div className="prompts-form">
      {simple && Object.keys(contracts).length > 0 && (
        <div
          className="prompts-input-mode"
          role="group"
          aria-label="Input format"
        >
          <Button
            size="sm"
            variant={json ? 'ghost' : 'secondary'}
            aria-pressed={!json}
            disabled={!valid || disabled}
            onPress={() => setJson(false)}
          >
            Fields
          </Button>
          <Button
            size="sm"
            variant={json ? 'secondary' : 'ghost'}
            aria-pressed={json}
            disabled={disabled}
            onPress={() => setJson(true)}
          >
            JSON
          </Button>
        </div>
      )}
      {json || !valid ? (
        <Textarea
          label={label}
          variant="outlined"
          rows={6}
          spellCheck={false}
          className="prompts-code-field"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        Object.entries(contracts).map(([key, spec]) => {
          const hint = 'default' in spec ? undefined : 'Required'
          if (spec.enum)
            return (
              <Select
                key={key}
                label={key}
                variant="outlined"
                disabled={disabled}
                hint={hint}
                options={spec.enum.map((item, index) => ({
                  id: String(index),
                  label: typeof item === 'string' ? item : JSON.stringify(item),
                }))}
                value={String(
                  spec.enum.findIndex(
                    (item) =>
                      JSON.stringify(item) === JSON.stringify(parsed[key]),
                  ),
                )}
                onChange={(index) => update(key, spec.enum?.[Number(index)])}
              />
            )
          if (spec.type === 'boolean')
            return (
              <Checkbox
                key={key}
                label={key}
                disabled={disabled}
                isSelected={parsed[key] === true}
                onChange={(next) => update(key, next)}
              />
            )
          if (spec.type === 'integer' || spec.type === 'number')
            return (
              <NumberField
                key={key}
                label={key}
                variant="outlined"
                disabled={disabled}
                hint={hint}
                value={typeof parsed[key] === 'number' ? parsed[key] : NaN}
                step={spec.type === 'integer' ? 1 : undefined}
                onChange={(next) => update(key, next)}
              />
            )
          return (
            <TextField
              key={key}
              label={key}
              variant="outlined"
              hint={hint}
              disabled={disabled}
              value={typeof parsed[key] === 'string' ? parsed[key] : ''}
              onChange={(event) => update(key, event.target.value)}
            />
          )
        })
      )}
      {!Object.keys(contracts).length && !json && (
        <p className="prompts-note">This prompt has no inputs.</p>
      )}
    </div>
  )
}
