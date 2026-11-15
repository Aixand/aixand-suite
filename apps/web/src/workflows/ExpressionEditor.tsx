import { useEffect, useState } from 'react'
import { Button, Select } from 'bbb-design'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { LiteralEditor, NameField } from './Fields'
import type {
  Diagnostic,
  Expression,
  Reference,
  ReferenceOption,
  Type,
  Workflow,
} from './ir'
import {
  defaultValue,
  initialExpression,
  ordinary,
  pointer,
  referenceLabel,
  renamed,
  typeLabel,
  uniqueName,
  without,
} from './ir'
import type { WorkflowConnection } from './client'
export type ExpressionContext = {
  workflow: Workflow
  client: WorkflowConnection | null
  before: number
  sequence?: string
  diagnostics: Diagnostic[]
}
export function Issues({
  diagnostics,
  path,
}: {
  diagnostics: Diagnostic[]
  path: string
}) {
  const local = diagnostics.filter(
    (d) => d.location === path || d.location.startsWith(`${path}/`)
  )
  return local.length ? (
    <ul className="wf-issues">
      {local.map((d, i) => (
        <li key={i} data-severity={d.severity}>
          {d.message}
        </li>
      ))}
    </ul>
  ) : null
}
export function ExpressionEditor({
  value,
  onChange,
  expected,
  label,
  path,
  optional = false,
  fallback,
  context,
}: {
  value?: Expression
  onChange: (value: Expression | undefined) => void
  expected: Type
  label: string
  path: string
  optional?: boolean
  fallback?: unknown
  context: ExpressionContext
}) {
  const fieldVariant = useContentFieldVariant()
  const mode =
    value?.kind === 'literal' && value.value === null
      ? 'null'
      : (value?.kind ?? 'omitted')
  const [options, setOptions] = useState<ReferenceOption[]>([])
  const [error, setError] = useState('')
  const source = JSON.stringify(context.workflow),
    type = JSON.stringify(expected)
  useEffect(() => {
    if (mode !== 'ref' || !context.client) return
    let current = true
    context.client
      .references(
        JSON.parse(source),
        JSON.parse(type),
        context.before,
        context.sequence
      )
      .then((result) => {
        if (current) {
          setOptions(result)
          setError('')
        }
      })
      .catch((error) => {
        if (current) {
          setOptions([])
          setError(error.message)
        }
      })
    return () => {
      current = false
    }
  }, [source, type, mode, context.before, context.client, context.sequence])
  const choices = [
    { id: 'omitted', label: optional ? 'Omitted' : 'Choose an expression' },
    ...(ordinary(expected) && expected.kind !== 'null'
      ? [{ id: 'literal', label: 'Value' }]
      : []),
    { id: 'ref', label: 'Reference' },
    ...(['boolean', 'json'].includes(expected.kind)
      ? [
          { id: 'compare', label: 'Compare' },
          { id: 'and', label: 'All (and)' },
          { id: 'or', label: 'Any (or)' },
          { id: 'not', label: 'Not' },
        ]
      : []),
    ...(['object', 'json'].includes(expected.kind)
      ? [{ id: 'object', label: 'Object' }]
      : []),
    ...(['array', 'json'].includes(expected.kind)
      ? [{ id: 'array', label: 'Array' }]
      : []),
    ...(expected.kind === 'null' ||
    expected.kind === 'json' ||
    ('nullable' in expected && expected.nullable)
      ? [{ id: 'null', label: 'Explicit null' }]
      : []),
  ]
  const reference = value?.kind === 'ref' ? value : undefined
  const selected = reference && JSON.stringify(reference)
  const matches = (a: Reference, b: Reference) =>
    JSON.stringify([
      a.source,
      a.source === 'input' ? a.name : a.step,
      a.source === 'step' ? a.output : '',
      a.path ?? [],
    ]) ===
    JSON.stringify([
      b.source,
      b.source === 'input' ? b.name : b.step,
      b.source === 'step' ? b.output : '',
      b.path ?? [],
    ])
  const available =
    reference && options.some((o) => matches(o.value, reference))
  return (
    <div className="wf-expression" data-ir-path={path}>
      <div className="wf-row">
          <Select label={`${label} expression`} variant={fieldVariant}
            value={mode}
            onChange={kind => {
              switch (kind) {
                case 'omitted':
                  onChange(undefined)
                  break
                case 'ref':
                  onChange({
                    kind: 'ref',
                    source: 'input',
                    name: 'select_reference',
                  })
                  break
                case 'literal':
                  onChange({
                    kind: 'literal',
                    value: defaultValue(
                      expected.kind === 'json' ? { kind: 'string' } : expected
                    ),
                  })
                  break
                case 'null':
                  onChange({ kind: 'literal', value: null })
                  break
                case 'object':
                  onChange({ kind: 'object', fields: {} })
                  break
                case 'array':
                  onChange({ kind: 'array', items: [] })
                  break
                case 'compare':
                  onChange({
                    kind: 'compare',
                    operator: 'eq',
                    left: { kind: 'literal', value: 0 },
                    right: { kind: 'literal', value: 0 },
                  })
                  break
                case 'and':
                case 'or':
                  onChange({
                    kind,
                    operands: [
                      { kind: 'literal', value: false },
                      { kind: 'literal', value: false },
                    ],
                  })
                  break
                case 'not':
                  onChange({
                    kind: 'not',
                    operand: { kind: 'literal', value: false },
                  })
                  break
              }
            }}
            options={[...(!choices.some(choice => choice.id === mode) ? [{ id: mode, label: `Current ${mode} (incompatible)` }] : []), ...choices]} />
        <span className="wf-type">{typeLabel(expected)}</span>
      </div>
      {mode === 'omitted' && (
        <p className="wf-hint">
          {optional
            ? fallback === undefined
              ? 'Not supplied to the operation.'
              : `Uses the contract default: ${JSON.stringify(fallback)}`
            : 'This input is required.'}
        </p>
      )}
      {value?.kind === 'literal' &&
        (expected.kind === 'opaque' && value.value !== null ? (
          <p className="wf-issues">
            Opaque values require a compatible reference.
          </p>
        ) : (
          <LiteralEditor
            label={`${label} value`}
            value={value.value}
            type={expected}
            onChange={(next) => onChange({ kind: 'literal', value: next })}
          />
        ))}
      {reference && (
        <>
            <Select label={`${label} reference`} variant={fieldVariant}
              value={
                available
                  ? JSON.stringify(
                      options.find((o) => matches(o.value, reference))!.value
                    )
                  : selected
              }
              onChange={value => onChange(JSON.parse(value))}
              options={[...(!available ? [{ id: selected!, label: reference.source === 'input' && reference.name === 'select_reference'
                ? 'Select a compatible reference' : `Unavailable here: ${referenceLabel(reference)}` }] : []),
                ...options.map(option => ({ id: JSON.stringify(option.value), label: option.label }))]} />
          {!options.length && (
            <p className="wf-hint">
              No compatible earlier values are available.
            </p>
          )}
          {error && <p className="wf-issues">{error}</p>}
          {reference.path?.length ? (
            <p className="wf-hint">
              Path:{' '}
              {reference.path
                .map((p) =>
                  typeof p === 'number' ? `[${p}]` : JSON.stringify(p)
                )
                .join(' → ')}
            </p>
          ) : null}
        </>
      )}
      {value?.kind === 'object' && (
        <div className="wf-nested">
          {Object.entries(value.fields).map(([name, child]) => (
            <div key={name} className="wf-property">
              <NameField
                label="Expression field name"
                value={name}
                names={Object.keys(value.fields)}
                onChange={(next) =>
                  onChange({
                    ...value,
                    fields: renamed(value.fields, name, next),
                  })
                }
              />
              <ExpressionEditor
                label={name}
                expected={
                  expected.kind === 'object'
                    ? (expected.properties[name] ?? expected.additional) || {
                        kind: 'json',
                      }
                    : { kind: 'json' }
                }
                value={child}
                context={context}
                path={pointer(pointer(path, 'fields'), name)}
                onChange={(child) =>
                  onChange({
                    ...value,
                    fields: child
                      ? { ...value.fields, [name]: child }
                      : without(value.fields, name),
                  })
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onPress={() =>
                  onChange({ ...value, fields: without(value.fields, name) })
                }
              >
                Remove expression field {name}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              const name =
                expected.kind === 'object'
                  ? (Object.keys(expected.properties).find(
                      (key) => !(key in value.fields)
                    ) ?? uniqueName('field', Object.keys(value.fields)))
                  : uniqueName('field', Object.keys(value.fields))
              const type =
                expected.kind === 'object'
                  ? (expected.properties[name] ?? expected.additional) || {
                      kind: 'json' as const,
                    }
                  : { kind: 'json' as const }
              onChange({
                ...value,
                fields: { ...value.fields, [name]: initialExpression(type) },
              })
            }}
          >
            Add expression field
          </Button>
        </div>
      )}
      {value?.kind === 'array' && (
        <div className="wf-nested">
          {value.items.map((child, index) => (
            <div key={index} className="wf-property">
              <ExpressionEditor
                label={`Item ${index + 1}`}
                expected={
                  expected.kind === 'array' ? expected.items : { kind: 'json' }
                }
                value={child}
                path={pointer(pointer(path, 'items'), index)}
                context={context}
                onChange={(next) =>
                  onChange({
                    ...value,
                    items: next
                      ? value.items.map((item, i) =>
                          i === index ? next : item
                        )
                      : value.items.filter((_, i) => i !== index),
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  onChange({
                    ...value,
                    items: value.items.filter((_, i) => i !== index),
                  })
                }
              >
                Remove expression item {index + 1}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onPress={() =>
              onChange({
                ...value,
                items: [
                  ...value.items,
                  initialExpression(
                    expected.kind === 'array'
                      ? expected.items
                      : { kind: 'json' }
                  ),
                ],
              })
            }
          >
            Add expression item
          </Button>
        </div>
      )}
      {value?.kind === 'compare' && (
        <ComparisonEditor {...{ value, context, path }} onChange={onChange} />
      )}
      {(value?.kind === 'and' || value?.kind === 'or') && (
        <div className="wf-nested">
          {value.operands.map((operand, index) => (
            <div className="wf-property" key={index}>
              <ExpressionEditor
                label={`Condition ${index + 1}`}
                expected={{ kind: 'boolean' }}
                value={operand}
                path={pointer(pointer(path, 'operands'), index)}
                context={context}
                onChange={(next) => {
                  if (next)
                    onChange({
                      ...value,
                      operands: value.operands.map((child, i) =>
                        i === index ? next : child
                      ),
                    })
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={value.operands.length <= 2}
                onPress={() =>
                  onChange({
                    ...value,
                    operands: value.operands.filter((_, i) => i !== index),
                  })
                }
              >
                Remove condition {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onPress={() =>
              onChange({
                ...value,
                operands: [
                  ...value.operands,
                  { kind: 'literal', value: false },
                ],
              })
            }
          >
            Add condition
          </Button>
        </div>
      )}
      {value?.kind === 'not' && (
        <div className="wf-nested">
          <ExpressionEditor
            label="Negated condition"
            expected={{ kind: 'boolean' }}
            value={value.operand}
            path={pointer(path, 'operand')}
            context={context}
            onChange={(operand) => {
              if (operand) onChange({ ...value, operand })
            }}
          />
        </div>
      )}
      <Issues
        diagnostics={context.diagnostics.filter(
          (d) =>
            !d.location.includes('/fields/') && !d.location.includes('/items/')
        )}
        path={path}
      />
    </div>
  )
}

function ComparisonEditor({
  value,
  onChange,
  context,
  path,
}: {
  value: Extract<Expression, { kind: 'compare' }>
  onChange: (value: Expression) => void
  context: ExpressionContext
  path: string
}) {
  const fieldVariant = useContentFieldVariant()
  // This type is a picker filter, never serialized. Actual operand types and
  // comparison compatibility are checked by aixand-ir.
  const [filter, setFilter] = useState<Type | null>(null)
  const [references, setReferences] = useState<ReferenceOption[]>([])
  const source = JSON.stringify(context.workflow)
  useEffect(() => {
    let current = true
    context.client
      ?.references(
        JSON.parse(source),
        { kind: 'json' },
        context.before,
        context.sequence
      )
      .then((options) => {
        if (current) setReferences(options)
      })
      .catch(() => {
        if (current) setReferences([])
      })
    return () => {
      current = false
    }
  }, [source, context.client, context.before, context.sequence])
  const inferred = (operand: Expression): Type | undefined => {
    if (operand.kind === 'ref')
      return references.find(
        (ref) => referenceLabel(ref.value) === referenceLabel(operand)
      )?.type
    if (operand.kind === 'literal') {
      if (typeof operand.value === 'boolean') return { kind: 'boolean' }
      if (typeof operand.value === 'string') return { kind: 'string' }
      if (typeof operand.value === 'number') return { kind: 'number' }
    }
    return undefined
  }
  const operandType = inferred(value.left) ?? inferred(value.right)
  const equality = value.operator === 'eq' || value.operator === 'ne'
  const category =
    filter ??
    (equality &&
    operandType &&
    ['boolean', 'string', 'integer', 'number'].includes(operandType.kind)
      ? operandType
      : ({ kind: 'number' } as Type))
  const expected: Type =
    category.kind === 'integer'
      ? { kind: 'number', nullable: equality }
      : {
          ...category,
          ...(['boolean', 'string', 'number'].includes(category.kind)
            ? { nullable: equality }
            : {}),
        }
  return (
    <div className="wf-nested wf-comparison">
      <div className="wf-row">
          <Select label="Comparison operator" variant={fieldVariant}
            value={value.operator}
            onChange={operator => {
              setFilter(null)
              onChange({
                ...value,
                operator: operator as typeof value.operator,
              })
            }}
            options={Object.entries({
              eq: 'Equals (==)',
              ne: 'Not equal (!=)',
              lt: 'Less than (<)',
              le: 'At most (<=)',
              gt: 'Greater than (>)',
              ge: 'At least (>=)',
            }).map(([id, label]) => ({ id, label }))} />
          <Select label="Comparison value type" variant={fieldVariant}
            value={expected.kind}
            onChange={kind => {
              const type: Type = {
                kind: kind as 'number' | 'string' | 'boolean',
              }
              setFilter(type)
              const literal = (operand: Expression): Expression =>
                operand.kind === 'literal' && operand.value !== null
                  ? { kind: 'literal', value: defaultValue(type) }
                  : operand
              onChange({
                ...value,
                left: literal(value.left),
                right: literal(value.right),
              })
            }}
            options={[{ id: 'number', label: 'Number' }, ...(equality ? [{ id: 'string', label: 'String' }, { id: 'boolean', label: 'Boolean' }] : [])]} />
      </div>
      <ExpressionEditor
        label="Left"
        expected={expected}
        value={value.left}
        path={pointer(path, 'left')}
        context={context}
        onChange={(left) => {
          if (left) onChange({ ...value, left })
        }}
      />
      <ExpressionEditor
        label="Right"
        expected={expected}
        value={value.right}
        path={pointer(path, 'right')}
        context={context}
        onChange={(right) => {
          if (right) onChange({ ...value, right })
        }}
      />
    </div>
  )
}
