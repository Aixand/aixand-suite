import { cloneElement, useEffect, useId, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from 'bbb-design'
import type { Json, Type } from './ir'
import { defaultValue, newType, renamed, uniqueName, without } from './ir'
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactElement<{ id?: string }>
  hint?: string
}) {
  const id = useId()
  return (
    <div className="wf-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
      {hint && <small>{hint}</small>}
    </div>
  )
}
export function NameField({
  label,
  value,
  names,
  onChange,
}: {
  label: string
  value: string
  names: string[]
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Field label={label}>
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          e.target.setCustomValidity('')
        }}
        onBlur={(e) => {
          if (draft !== value && names.includes(draft)) {
            e.target.setCustomValidity('That name is already in use')
            e.target.reportValidity()
            return
          }
          if (draft !== value) onChange(draft)
        }}
      />
    </Field>
  )
}
export function TypeEditor({
  value,
  onChange,
  label = 'Type',
}: {
  value: Type
  onChange: (value: Type) => void
  label?: string
}) {
  return (
    <div className="wf-type-editor">
      <div className="wf-row">
        <Field label={label}>
          <select
            value={value.kind}
            onChange={(e) => onChange(newType(e.target.value as Type['kind']))}
          >
            {[
              'string',
              'boolean',
              'integer',
              'number',
              'null',
              'json',
              'array',
              'object',
              'opaque',
            ].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </Field>
        {'nullable' in value || !['json', 'null'].includes(value.kind) ? (
          <label className="wf-check">
            <input
              type="checkbox"
              checked={'nullable' in value && !!value.nullable}
              onChange={(e) =>
                onChange({ ...value, nullable: e.target.checked } as Type)
              }
            />
            Nullable
          </label>
        ) : null}
      </div>
      {value.kind === 'opaque' && (
        <div className="wf-row">
          <Field label="Opaque type ID">
            <input
              value={value.id}
              onChange={(e) => onChange({ ...value, id: e.target.value })}
            />
          </Field>
          <Field label="Type version">
            <input
              value={value.version}
              onChange={(e) => onChange({ ...value, version: e.target.value })}
            />
          </Field>
        </div>
      )}
      {value.kind === 'array' && (
        <TypeEditor
          label="Item type"
          value={value.items}
          onChange={(items) => onChange({ ...value, items })}
        />
      )}
      {value.kind === 'object' && (
        <div className="wf-nested">
          {Object.entries(value.properties).map(([name, type]) => (
            <div className="wf-property" key={name}>
              <NameField
                label="Property name"
                value={name}
                names={Object.keys(value.properties)}
                onChange={(next) =>
                  onChange({
                    ...value,
                    properties: renamed(value.properties, name, next),
                    required: value.required.map((key) =>
                      key === name ? next : key
                    ),
                  })
                }
              />
              <TypeEditor
                value={type}
                onChange={(type) =>
                  onChange({
                    ...value,
                    properties: { ...value.properties, [name]: type },
                  })
                }
              />
              <div className="wf-row">
                <label className="wf-check">
                  <input
                    type="checkbox"
                    checked={value.required.includes(name)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        required: e.target.checked
                          ? [...value.required, name]
                          : value.required.filter((key) => key !== name),
                      })
                    }
                  />
                  Required property
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() =>
                    onChange({
                      ...value,
                      properties: without(value.properties, name),
                      required: value.required.filter((key) => key !== name),
                    })
                  }
                >
                  Remove property {name}
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              const name = uniqueName('property', Object.keys(value.properties))
              onChange({
                ...value,
                properties: { ...value.properties, [name]: { kind: 'string' } },
              })
            }}
          >
            Add property
          </Button>
          <label className="wf-check">
            <input
              type="checkbox"
              checked={!!value.additional}
              onChange={(e) =>
                onChange({
                  ...value,
                  additional: e.target.checked ? { kind: 'json' } : false,
                })
              }
            />
            Allow additional properties
          </label>
          {value.additional && (
            <TypeEditor
              label="Additional property type"
              value={value.additional}
              onChange={(additional) => onChange({ ...value, additional })}
            />
          )}
        </div>
      )}
    </div>
  )
}
function valueKind(value: Json): Type['kind'] {
  return value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'object'
        ? 'object'
        : (typeof value as 'string' | 'number' | 'boolean')
}
export function LiteralEditor({
  value,
  type,
  onChange,
  label = 'Value',
}: {
  value: Json
  type: Type
  onChange: (value: Json) => void
  label?: string
}) {
  const actual = valueKind(value)
  const dynamic = type.kind === 'json'
  return (
    <div className="wf-literal">
      {dynamic && (
        <Field label={`${label} kind`}>
          <select
            value={actual}
            onChange={(e) =>
              onChange(defaultValue(newType(e.target.value as Type['kind'])))
            }
          >
            {['null', 'string', 'boolean', 'number', 'object', 'array'].map(
              (kind) => (
                <option key={kind}>{kind}</option>
              )
            )}
          </select>
        </Field>
      )}
      {value === null ? (
        <div className="wf-row">
          <code>null</code>
          {type.kind !== 'null' && type.kind !== 'opaque' && (
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                onChange(
                  defaultValue(type.kind === 'json' ? { kind: 'string' } : type)
                )
              }
            >
              Set a value
            </Button>
          )}
        </div>
      ) : typeof value === 'string' ? (
        <Field label={label}>
          <textarea
            rows={2}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      ) : typeof value === 'boolean' ? (
        <Field label={label}>
          <select
            value={String(value)}
            onChange={(e) => onChange(e.target.value === 'true')}
          >
            <option>true</option>
            <option>false</option>
          </select>
        </Field>
      ) : typeof value === 'number' ? (
        <NumberField label={label} value={value} onChange={onChange} />
      ) : Array.isArray(value) ? (
        <div className="wf-nested">
          {value.map((child, index) => (
            <div className="wf-property" key={index}>
              <LiteralEditor
                label={`${label} item ${index + 1}`}
                type={type.kind === 'array' ? type.items : { kind: 'json' }}
                value={child}
                onChange={(next) =>
                  onChange(value.map((item, i) => (i === index ? next : item)))
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onPress={() => onChange(value.filter((_, i) => i !== index))}
              >
                Remove value item {index + 1}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onPress={() =>
              onChange([
                ...value,
                defaultValue(
                  type.kind === 'array' ? type.items : { kind: 'json' }
                ),
              ])
            }
          >
            Add value item
          </Button>
        </div>
      ) : (
        <div className="wf-nested">
          {Object.entries(value).map(([key, child]) => (
            <div className="wf-property" key={key}>
              <NameField
                label="Value field name"
                value={key}
                names={Object.keys(value)}
                onChange={(name) => onChange(renamed(value, key, name))}
              />
              <LiteralEditor
                label={key}
                type={
                  type.kind === 'object'
                    ? (type.properties[key] ?? type.additional) || {
                        kind: 'json',
                      }
                    : { kind: 'json' }
                }
                value={child}
                onChange={(next) => onChange({ ...value, [key]: next })}
              />
              <Button
                variant="ghost"
                size="sm"
                onPress={() => onChange(without(value, key))}
              >
                Remove value field {key}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              const key = uniqueName('field', Object.keys(value))
              onChange({ ...value, [key]: null })
            }}
          >
            Add value field
          </Button>
        </div>
      )}
      {'nullable' in type && type.nullable && value !== null && (
        <Button size="sm" variant="ghost" onPress={() => onChange(null)}>
          Set null
        </Button>
      )}
    </div>
  )
}
function NumberField({
  value,
  onChange,
  label,
}: {
  value: number
  onChange: (value: number) => void
  label: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <Field label={label}>
      <input
        type="number"
        step="any"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (e.target.value && Number.isFinite(Number(e.target.value)))
            onChange(Number(e.target.value))
        }}
        onBlur={() => setText(String(value))}
      />
    </Field>
  )
}
