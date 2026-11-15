// TypeScript declarations mirror the portable IR records. Validation and type
// compatibility are provided by aixand-ir in the Rust bridge.
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json }
export type Type =
  | { kind: 'null' | 'json' }
  | { kind: 'boolean' | 'integer' | 'number' | 'string'; nullable?: boolean }
  | { kind: 'array'; items: Type; nullable?: boolean }
  | {
      kind: 'object'
      properties: Record<string, Type>
      required: string[]
      additional?: false | Type
      nullable?: boolean
    }
  | { kind: 'opaque'; id: string; version: string; nullable?: boolean }
export type Reference = { kind: 'ref'; path?: (string | number)[] } & (
  | { source: 'input'; name: string }
  | { source: 'step'; step: string; output: string }
)
export type Expression =
  | { kind: 'literal'; value: Json }
  | Reference
  | { kind: 'object'; fields: Record<string, Expression> }
  | { kind: 'array'; items: Expression[] }
  | {
      kind: 'compare'
      operator: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
      left: Expression
      right: Expression
    }
  | { kind: 'and' | 'or'; operands: Expression[] }
  | { kind: 'not'; operand: Expression }
export type Input = { type: Type; default?: Json; description?: string }
export type Output = { type: Type; value: Expression; description?: string }
export type Operation = {
  id: string
  version: string
  title?: string
  description?: string
  inputs: Record<string, Input & { required: boolean }>
  outputs: Record<string, { type: Type; description?: string }>
}
export type Catalog = {
  contract_version: '0.1'
  package: {
    id: string
    version: string
    title?: string
    description?: string
  }
  operations: Operation[]
}
export type OperationStep = {
  kind: 'operation'
  id: string
  operation: { id: string; version: string }
  inputs: Record<string, Expression>
}
export type Branch = {
  kind: 'branch'
  id: string
  condition: Expression
  then: Sequence
  else?: Sequence
}
export type Step = OperationStep | Branch
export type Sequence = { kind: 'sequence'; steps: Step[] }
export type Workflow = {
  ir_version: '0.1' | '0.2'
  name?: string
  description?: string
  inputs: Record<string, Input>
  body: Sequence
  outputs: Record<string, Output>
}
export type Diagnostic = {
  code: string
  message: string
  location: string
  severity: 'error' | 'warning'
  invocation_id?: string
  operation?: { id: string; version: string }
}
export type Validation = {
  valid: boolean
  phase?: string
  diagnostics: Diagnostic[]
  document?: Workflow
  canonical?: string
}
export type ReferenceOption = { label: string; value: Reference; type: Type }
export type Failure = {
  code: string
  message: string
  invocation_id?: string
  operation?: { id: string; version: string }
  details?: Json
  cleanup_errors?: Failure[]
}
export type RunEvent = {
  event:
    | 'prepared'
    | 'started'
    | 'published'
    | 'failed'
    | 'completed'
    | 'branch_evaluated'
    | 'chat_step'
  invocation?: string
  status?: string
  chat_id?: string | null
  permission_mode?: import('../agents/permissions').PermissionMode
  sdk_approval_policy?: 'ask' | 'deny'
  permission_source?: string
  profile_selection?: import('../agents/profileSelection').ProfileSelection
  profile_decision?: import('../agents/profileSelection').ProfileDecision | null
  failure?: Failure
  result?: boolean
  selected?: 'then' | 'else'
}
export const emptyWorkflow = (): Workflow => ({
  ir_version: '0.1',
  name: 'untitled_workflow',
  inputs: {},
  body: { kind: 'sequence', steps: [] },
  outputs: {},
})
export function typeLabel(type: Type): string {
  let label: string = type.kind
  if (type.kind === 'opaque') label = `${type.id}@${type.version}`
  if (type.kind === 'array') label = `array<${typeLabel(type.items)}>`
  return `${label}${'nullable' in type && type.nullable ? '?' : ''}`
}
export function newType(kind: Type['kind']): Type {
  if (kind === 'array') return { kind, items: { kind: 'string' } }
  if (kind === 'object') return { kind, properties: {}, required: [] }
  if (kind === 'opaque') return { kind, id: 'package.value', version: '1' }
  return { kind }
}
export function ordinary(type: Type): boolean {
  if (type.kind === 'opaque') return false
  if (type.kind === 'array') return ordinary(type.items)
  if (type.kind === 'object')
    return (
      Object.values(type.properties).every(ordinary) &&
      (!type.additional || ordinary(type.additional))
    )
  return true
}
export function defaultValue(type: Type): Json {
  switch (type.kind) {
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return null
  }
}
export function initialExpression(type: Type): Expression {
  if (type.kind === 'opaque')
    return { kind: 'ref', source: 'input', name: 'select_reference' }
  if (type.kind === 'object') return { kind: 'object', fields: {} }
  if (type.kind === 'array') return { kind: 'array', items: [] }
  return { kind: 'literal', value: defaultValue(type) }
}
export function uniqueName(prefix: string, names: string[]): string {
  let count = 1
  while (names.includes(`${prefix}_${count}`)) count++
  return `${prefix}_${count}`
}
// Paths address actual IR sequences. They are editor locations, not workflow state.
export function sequenceAt(workflow: Workflow, path = '/body'): Sequence {
  let sequence = workflow.body
  const segments = path.slice('/body'.length).split('/').filter(Boolean)
  for (let i = 0; i < segments.length; i += 3) {
    const branch = sequence.steps[Number(segments[i + 1])]
    if (branch.kind !== 'branch')
      throw new Error('Expected a Branch at this location')
    sequence = branch[segments[i + 2] as 'then' | 'else']!
  }
  return sequence
}
export function updateSequence(
  workflow: Workflow,
  path: string,
  update: (sequence: Sequence) => Sequence
): Workflow {
  const segments = path.slice('/body'.length).split('/').filter(Boolean)
  const visit = (sequence: Sequence, offset: number): Sequence => {
    if (offset === segments.length) return update(sequence)
    const index = Number(segments[offset + 1]),
      arm = segments[offset + 2] as 'then' | 'else'
    return {
      ...sequence,
      steps: sequence.steps.map((step, i) => {
        if (i !== index || step.kind !== 'branch') return step
        return { ...step, [arm]: visit(step[arm]!, offset + 3) }
      }),
    }
  }
  return { ...workflow, body: visit(workflow.body, 0) }
}
function expressions(
  expression: Expression,
  visit: (value: Expression) => void
) {
  visit(expression)
  if (expression.kind === 'object')
    Object.values(expression.fields).forEach((child) =>
      expressions(child, visit)
    )
  if (expression.kind === 'array')
    expression.items.forEach((child) => expressions(child, visit))
  if (expression.kind === 'compare') {
    expressions(expression.left, visit)
    expressions(expression.right, visit)
  }
  if (expression.kind === 'and' || expression.kind === 'or')
    expression.operands.forEach((child) => expressions(child, visit))
  if (expression.kind === 'not') expressions(expression.operand, visit)
}
export function walkWorkflow(
  workflow: Workflow,
  step: (step: Step) => void,
  expression: (expression: Expression) => void
) {
  const visit = (sequence: Sequence) =>
    sequence.steps.forEach((node) => {
      step(node)
      if (node.kind === 'branch') {
        expressions(node.condition, expression)
        visit(node.then)
        if (node.else) visit(node.else)
      } else
        Object.values(node.inputs).forEach((value) =>
          expressions(value, expression)
        )
    })
  visit(workflow.body)
  Object.values(workflow.outputs).forEach((output) =>
    expressions(output.value, expression)
  )
}
export function withRequiredVersion(workflow: Workflow): Workflow {
  let branching = workflow.ir_version === '0.2'
  walkWorkflow(
    workflow,
    (step) => {
      if (step.kind === 'branch') branching = true
    },
    (value) => {
      if (['compare', 'and', 'or', 'not'].includes(value.kind)) branching = true
    }
  )
  return branching && workflow.ir_version !== '0.2'
    ? { ...workflow, ir_version: '0.2' }
    : workflow
}
function nextId(workflow: Workflow, prefix: string): string {
  // Reserve dangling references too: adding a producer cannot repair a reference
  // by silently attaching it to a different invocation, including across arms.
  const reserved: string[] = []
  walkWorkflow(
    workflow,
    (step) => reserved.push(step.id),
    (value) => {
      if (value.kind === 'ref' && value.source === 'step')
        reserved.push(value.step)
    }
  )
  return uniqueName(prefix, reserved)
}
export function addOperation(
  workflow: Workflow,
  operation: Operation,
  path = '/body'
): Workflow {
  return updateSequence(workflow, path, (sequence) => ({
    ...sequence,
    steps: [
      ...sequence.steps,
      {
        kind: 'operation',
        id: nextId(workflow, operation.id.split('.').at(-1)!),
        operation: { id: operation.id, version: operation.version },
        inputs: {},
      },
    ],
  }))
}
export function addBranch(workflow: Workflow, path = '/body'): Workflow {
  return withRequiredVersion(
    updateSequence(workflow, path, (sequence) => ({
      ...sequence,
      steps: [
        ...sequence.steps,
        {
          kind: 'branch',
          id: nextId(workflow, 'branch'),
          condition: { kind: 'literal', value: false },
          // oxlint-disable-next-line unicorn/no-thenable -- IR field is a Sequence, never a function.
          then: { kind: 'sequence', steps: [] },
          else: { kind: 'sequence', steps: [] },
        },
      ],
    }))
  )
}
export function moveStep(
  workflow: Workflow,
  index: number,
  offset: number,
  path = '/body'
): Workflow {
  return updateSequence(workflow, path, (sequence) => {
    const steps = [...sequence.steps],
      destination = index + offset
    if (destination < 0 || destination >= steps.length) return sequence
    ;[steps[index], steps[destination]] = [steps[destination], steps[index]]
    return { ...sequence, steps }
  })
}
export function without<T>(
  record: Record<string, T>,
  key: string
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== key)
  )
}
export function renamed<T>(
  record: Record<string, T>,
  old: string,
  name: string
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key === old ? name : key,
      value,
    ])
  )
}
export const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`
export const referenceLabel = (ref: Reference) =>
  `${ref.source === 'input' ? `workflow.${ref.name}` : `${ref.step}.${ref.output}`}${ref.path?.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('') ?? ''}`
