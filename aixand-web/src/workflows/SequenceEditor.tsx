import { useState } from 'react'
import { Button, Icon } from 'bbb-design'
import { Field } from './Fields'
import { ExpressionEditor, Issues } from './ExpressionEditor'
import type { WorkflowConnection } from './client'
import type {
  Catalog,
  Diagnostic,
  Expression,
  Operation,
  OperationStep,
  Step,
  Workflow,
} from './ir'
import {
  addBranch,
  addOperation,
  moveStep,
  pointer,
  sequenceAt,
  typeLabel,
  updateSequence,
  without,
} from './ir'

type Props = {
  workflow: Workflow
  catalogs: Catalog[]
  client: WorkflowConnection | null
  diagnostics: Diagnostic[]
  onChange: (workflow: Workflow) => void
  sequencePath?: string
}
export function SequenceEditor({
  workflow,
  catalogs,
  client,
  diagnostics,
  onChange,
  sequencePath = '/body',
}: Props) {
  const [operationChoice, setOperationChoice] = useState('')
  const sequence = sequenceAt(workflow, sequencePath)
  const operations = catalogs.flatMap((catalog) => catalog.operations)
  const replace = (index: number, next: Step) =>
    onChange(
      updateSequence(workflow, sequencePath, (sequence) => ({
        ...sequence,
        steps: sequence.steps.map((step, i) => (i === index ? next : step)),
      }))
    )
  return (
    <div className="wf-sequence" data-sequence-path={sequencePath}>
      <ol className="wf-steps">
        {sequence.steps.map((step, index) => {
          const path = pointer(pointer(sequencePath, 'steps'), index)
          const operation =
            step.kind === 'operation'
              ? operations.find(
                  (op) =>
                    op.id === step.operation.id &&
                    op.version === step.operation.version
                )
              : undefined
          return (
            <li
              className={`wf-step${step.kind === 'branch' ? ' wf-branch' : ''}`}
              key={step.id}
              data-step-id={step.id}
              data-ir-path={path}
            >
              <div className="wf-step-heading">
                <span className="wf-step-number">{index + 1}</span>
                <div>
                  <h3>
                    {step.kind === 'branch'
                      ? 'If condition'
                      : (operation?.title ??
                        step.operation.id
                          .split('.')
                          .at(-1)
                          ?.replace(/^./, (c) => c.toUpperCase()))}
                  </h3>
                  <code>{step.id}</code>
                </div>
                <div className="wf-step-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${step.id} up`}
                    disabled={index === 0}
                    onPress={() =>
                      onChange(moveStep(workflow, index, -1, sequencePath))
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${step.id} down`}
                    disabled={index === sequence.steps.length - 1}
                    onPress={() =>
                      onChange(moveStep(workflow, index, 1, sequencePath))
                    }
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${step.id}`}
                    onPress={() =>
                      onChange(
                        updateSequence(workflow, sequencePath, (sequence) => ({
                          ...sequence,
                          steps: sequence.steps.filter((_, i) => i !== index),
                        }))
                      )
                    }
                  >
                    <Icon name="x" />
                  </Button>
                </div>
              </div>
              {step.kind === 'branch' ? (
                <>
                  <Issues
                    path={path}
                    diagnostics={diagnostics.filter(
                      (d) => d.location === path || d.location === `${path}/id`
                    )}
                  />
                  <ExpressionEditor
                    label="Condition"
                    expected={{ kind: 'boolean' }}
                    value={step.condition}
                    path={pointer(path, 'condition')}
                    context={{
                      workflow,
                      client,
                      diagnostics,
                      before: index,
                      sequence: sequencePath,
                    }}
                    onChange={(condition) => {
                      if (condition) replace(index, { ...step, condition })
                    }}
                  />
                  <p className="wf-hint">
                    Exactly one arm runs. Values created inside an arm stay
                    local to it.
                  </p>
                  <div className="wf-branch-arms">
                    <section
                      className="wf-branch-arm"
                      aria-label={`${step.id} THEN`}
                    >
                      <h4>THEN</h4>
                      <SequenceEditor
                        {...{
                          workflow,
                          catalogs,
                          client,
                          diagnostics,
                          onChange,
                        }}
                        sequencePath={pointer(path, 'then')}
                      />
                    </section>
                    <section
                      className="wf-branch-arm"
                      aria-label={`${step.id} ELSE`}
                    >
                      <h4>ELSE</h4>
                      {step.else ? (
                        <>
                          <SequenceEditor
                            {...{
                              workflow,
                              catalogs,
                              client,
                              diagnostics,
                              onChange,
                            }}
                            sequencePath={pointer(path, 'else')}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => {
                              const next = { ...step }
                              delete next.else
                              replace(index, next)
                            }}
                          >
                            Remove ELSE arm
                          </Button>
                        </>
                      ) : (
                        <>
                          <p className="wf-hint">
                            When false, continue to the next step.
                          </p>
                          <Button
                            variant="secondary"
                            size="sm"
                            onPress={() =>
                              replace(index, {
                                ...step,
                                else: { kind: 'sequence', steps: [] },
                              })
                            }
                          >
                            Add ELSE arm
                          </Button>
                        </>
                      )}
                    </section>
                  </div>
                </>
              ) : (
                <OperationFields
                  {...{
                    workflow,
                    client,
                    diagnostics,
                    operation,
                    step,
                    index,
                    path,
                    sequencePath,
                  }}
                  updateInputs={(inputs) => replace(index, { ...step, inputs })}
                />
              )}
            </li>
          )
        })}
      </ol>
      <div className="wf-add-step">
        <Field label="Operation catalog">
          <select
            value={operationChoice}
            onChange={(e) => setOperationChoice(e.target.value)}
          >
            <option value="">Choose an operation</option>
            {catalogs.map((catalog) => (
              <optgroup
                label={catalog.package.title ?? catalog.package.id}
                key={`${catalog.package.id}@${catalog.package.version}`}
              >
                {catalog.operations.map((op) => (
                  <option
                    key={`${op.id}@${op.version}`}
                    value={`${op.id}@${op.version}`}
                  >
                    {op.title ?? op.id} @ {op.version}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Button
          disabled={!operationChoice}
          onPress={() => {
            const op = operations.find(
              (op) => `${op.id}@${op.version}` === operationChoice
            )
            if (op) onChange(addOperation(workflow, op, sequencePath))
          }}
        >
          Add Step
        </Button>
        <Button
          variant="secondary"
          onPress={() => onChange(addBranch(workflow, sequencePath))}
        >
          Add Branch
        </Button>
      </div>
    </div>
  )
}
function OperationFields({
  workflow,
  client,
  diagnostics,
  operation,
  step,
  index,
  path,
  sequencePath,
  updateInputs,
}: {
  workflow: Workflow
  client: WorkflowConnection | null
  diagnostics: Diagnostic[]
  operation?: Operation
  step: OperationStep
  index: number
  path: string
  sequencePath: string
  updateInputs: (inputs: Record<string, Expression>) => void
}) {
  const ports = Object.entries(operation?.inputs ?? {})
  const context = {
    workflow,
    client,
    before: index,
    sequence: sequencePath,
    diagnostics,
  }
  const port = ([name, input]: (typeof ports)[number]) => (
    <div className="wf-port" key={name}>
      <div className="wf-port-heading">
        <strong>{name}</strong>
        <span>{input.required ? 'Required' : 'Optional'}</span>
      </div>
      {input.description && <p className="wf-hint">{input.description}</p>}
      <ExpressionEditor
        label={name}
        value={step.inputs[name]}
        expected={input.type}
        optional={!input.required}
        fallback={input.default}
        path={pointer(pointer(path, 'inputs'), name)}
        context={context}
        onChange={(value) =>
          updateInputs(
            value
              ? { ...step.inputs, [name]: value }
              : without(step.inputs, name)
          )
        }
      />
    </div>
  )
  return (
    <>
      <details className="wf-contract">
        <summary>
          {step.operation.id} @ {step.operation.version}
        </summary>
        <p>
          {operation?.description ??
            'This operation is not in the connected catalog.'}
        </p>
      </details>
      <Issues
        path={path}
        diagnostics={diagnostics.filter(
          (d) => !d.location.includes('/inputs/')
        )}
      />
      {ports
        .filter(([name, input]) => input.required || name in step.inputs)
        .map(port)}
      {ports.some(
        ([name, input]) => !input.required && !(name in step.inputs)
      ) && (
        <details className="wf-optional">
          <summary>Optional inputs</summary>
          {ports
            .filter(
              ([name, input]) => !input.required && !(name in step.inputs)
            )
            .map(port)}
        </details>
      )}
      {Object.keys(step.inputs)
        .filter((name) => !operation?.inputs[name])
        .map((name) => (
          <div className="wf-issues" key={name}>
            <p>Unrecognized input: {name}</p>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => updateInputs(without(step.inputs, name))}
            >
              Remove unrecognized input {name}
            </Button>
          </div>
        ))}
      <div className="wf-operation-outputs">
        <span>Outputs</span>
        {Object.entries(operation?.outputs ?? {}).map(([name, output]) => (
          <span
            className="wf-output-chip"
            key={name}
            title={output.description}
          >
            {name} <code>{typeLabel(output.type)}</code>
          </span>
        ))}
        {operation && !Object.keys(operation.outputs).length && (
          <span className="wf-hint">No outputs</span>
        )}
      </div>
    </>
  )
}
