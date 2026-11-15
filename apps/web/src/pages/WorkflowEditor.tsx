import { readStorage } from '../storage'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, PageHeader, TextField } from 'bbb-design'
import { WorkflowConnection } from '../workflows/client'
import { useConnectionRecovery } from '../auth/useConnectionRecovery'
import type { CatalogResult } from '../workflows/client'
import { ExpressionEditor, Issues } from '../workflows/ExpressionEditor'
import {
  Field,
  LiteralEditor,
  NameField,
  TypeEditor,
} from '../workflows/Fields'
import { RunPanel } from '../workflows/RunPanel'
import { SequenceEditor } from '../workflows/SequenceEditor'
import type { Catalog, Validation, Workflow } from '../workflows/ir'
import {
  defaultValue,
  emptyWorkflow,
  initialExpression,
  ordinary,
  pointer,
  renamed,
  uniqueName,
  without,
  withRequiredVersion,
} from '../workflows/ir'
import '../workflows/workflows.css'
const STORAGE = 'aixand.ir.workflow.v0.1'
export function WorkflowEditor({ onPlans }: { onPlans: () => void }) {
  const [workflow, setWorkflow] = useState<Workflow>(emptyWorkflow)
  const [catalogs, setCatalogs] = useState<Catalog[]>([])
  const [client, setClient] = useState<WorkflowConnection | null>(null)
  const clientRef = useRef<WorkflowConnection | null>(null)
  const recovery = useConnectionRecovery(connect)
  const [connecting, setConnecting] = useState(true)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [validation, setValidation] = useState<Validation | null>(null)
  const [validatedSource, setValidatedSource] = useState('')
  const [running, setRunning] = useState(false)
  const [raw, setRaw] = useState(''),
    [showImport, setShowImport] = useState(false)
  const [fileError, setFileError] = useState('')
  const restore = useRef<string | null>(null)
  const source = JSON.stringify(workflow)
  const diagnostics = validation?.diagnostics ?? []
  const valid = validation?.valid === true && validatedSource === source
  useEffect(() => {
    try {
      restore.current = readStorage(STORAGE)
    } catch {
      /* Browser storage is optional. */
    }
    return () => {
      const current = clientRef.current
      clientRef.current = null
      current?.close()
    }
  }, [])
  const change = (draft: Workflow) => {
    const next = withRequiredVersion(draft)
    restore.current = null
    setWorkflow(next)
    setNotice('')
    try {
      localStorage.setItem(STORAGE, JSON.stringify(next))
    } catch {
      setNotice(
        'This browser could not save the draft. Export it to keep your changes.'
      )
    }
  }
  useEffect(() => {
    if (!client) return
    let current = true
    const timer = setTimeout(() => {
      client
        .validate(source)
        .then((result) => {
          if (current) {
            setValidation(result)
            setValidatedSource(source)
          }
        })
        .catch((error) => {
          if (current) setError(error.message)
        })
    }, 200)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [source, client])
  function connect() {
    const previous = clientRef.current
    clientRef.current = null
    previous?.close()
    setClient(null)
    setConnecting(true)
    const connection = new WorkflowConnection(
      () => {
        if (clientRef.current !== connection) return
        recovery.ready()
        setClient(connection)
        setConnecting(false)
        setError('')
        connection
          .request<CatalogResult>('catalogs')
          .then((result) => {
            if (clientRef.current !== connection) return
            setCatalogs(result.catalogs)
          })
          .catch((error) => { if (clientRef.current === connection) setError(error.message) })
        if (restore.current) {
          const saved = restore.current
          restore.current = null
          connection
            .validate(saved)
            .then((result) => {
              if (clientRef.current !== connection) return
              if (result.document) setWorkflow(result.document)
              else
                setError(
                  'The saved draft could not be loaded. Import a valid workflow document to continue.'
                )
            })
            .catch((error) => { if (clientRef.current === connection) setError(error.message) })
        }
      },
      (message) => {
        if (clientRef.current !== connection) return
        clientRef.current = null
        setClient(null)
        setConnecting(false)
        setError(message)
        recovery.failed()
      }
    )
    clientRef.current = connection
  }
  async function load(source: string) {
    if (!client) return
    const result = await client.validate(source)
    setValidation(result)
    setValidatedSource(source)
    if (result.document) {
      change(result.document)
      setShowImport(false)
      setFileError('')
    } else
      setFileError(
        'The document could not be loaded. Fix the structural errors below.'
      )
  }
  async function example(variant: string) {
    if (!client) return
    try {
      const result = await client.request<{ document: Workflow }>('example', {
        variant,
      })
      change(result.document)
    } catch (error) {
      setError((error as Error).message)
    }
  }
  async function exportIR() {
    if (!client) return
    try {
      const result = await client.validate(source)
      setValidation(result)
      setValidatedSource(source)
      if (!result.valid || !result.canonical) return
      const url = URL.createObjectURL(
        new Blob([result.canonical], { type: 'application/json' })
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${workflow.name || 'workflow'}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setNotice('Valid canonical IR exported.')
    } catch (error) {
      setError((error as Error).message)
    }
  }
  return (
    <div className="page-stack wf-editor">
      <PageHeader
        title="Workflows"
        eyebrow={`AIXAND IR · V${workflow.ir_version}`}
        description="Build workflows with operations and conditional branches."
        actions={
          <Button variant="secondary" onPress={onPlans}>
            Demo plans
          </Button>
        }
      />
      <section className="wf-connection" aria-label="Workflow connection">
        <div>
          <strong>
            {client ? 'Connected to workspace' : error ? 'Reconnecting to your workspace…' : 'Connecting to your workspace…'}
          </strong>
          <p className="wf-hint">
            {client
              ? 'Catalogs, validation and execution use the local Aixand backend.'
              : 'Your workspace connects automatically.'}
          </p>
        </div>
        {client ? (
          <Badge tone="success" dot>
            Connected
          </Badge>
        ) : !connecting ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              recovery.reconnect()
            }}
            className="wf-connect-form"
          >
            <Button type="submit">
              Retry connection
            </Button>
          </form>
        ) : null}
      </section>
      {error && (
        <p role="alert" className="wf-issues">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <fieldset disabled={running} className="wf-fieldset">
        <div className="wf-toolbar">
          <Button variant="secondary" onPress={() => change(emptyWorkflow())}>
            <Icon name="plus" />
            New workflow
          </Button>
          <Button
            variant="secondary"
            disabled={!client}
            onPress={() => {
              void example('hand')
            }}
          >
            Load verified example
          </Button>
          <Button
            variant="ghost"
            disabled={!client}
            onPress={() => {
              void example('python')
            }}
          >
            Load compiled example
          </Button>
          <Button
            variant="ghost"
            disabled={!client}
            onPress={() => setShowImport(!showImport)}
          >
            Import IR
          </Button>
          <Button
            disabled={!valid}
            onPress={() => {
              void exportIR()
            }}
          >
            Export IR
          </Button>
          <Button
            variant="secondary"
            disabled={!client}
            onPress={() => void example('branch')}
          >
            Load branching example
          </Button>
          <Button
            variant="secondary"
            disabled={!client}
            onPress={() => void example('branch-python')}
          >
            Load Python branch IR
          </Button>
        </div>
        {showImport && (
          <section className="wf-section">
            <h2>Import workflow IR</h2>
            <Field label="Workflow JSON file">
              <input
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file)
                    void file
                      .text()
                      .then(load)
                      .catch((error) => setFileError(error.message))
                }}
              />
            </Field>
            <Field label="Workflow IR to import">
              <textarea
                rows={10}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
            </Field>
            <Button
              disabled={!raw}
              onPress={() => {
                void load(raw).catch((error) => setFileError(error.message))
              }}
            >
              Load document
            </Button>
            {fileError && (
              <p role="alert" className="wf-issues">
                {fileError}
              </p>
            )}
          </section>
        )}
        <section className="wf-section" aria-label="Workflow settings">
          <div className="section-heading">
            <h2>Workflow</h2>
            <span className="wf-type">
              {workflow.ir_version === '0.1' ? 'Sequential' : 'Structured'} ·{' '}
              {workflow.ir_version}
            </span>
          </div>
          <TextField
            label="Workflow name"
            value={workflow.name ?? ''}
            onChange={(e) => change({ ...workflow, name: e.target.value })}
          />
          <Field label="Workflow description">
            <textarea
              rows={2}
              value={workflow.description ?? ''}
              onChange={(e) =>
                change({ ...workflow, description: e.target.value })
              }
            />
          </Field>
        </section>
        <section className="wf-section" aria-label="Workflow inputs">
          <div className="section-heading">
            <h2>Inputs</h2>
            <span className="muted">
              Values supplied when the workflow runs
            </span>
          </div>
          {Object.entries(workflow.inputs).map(([name, input]) => (
            <div
              className="wf-port"
              key={name}
              data-ir-path={pointer('/inputs', name)}
            >
              <div className="wf-row">
                <NameField
                  label="Input name"
                  value={name}
                  names={Object.keys(workflow.inputs)}
                  onChange={(next) =>
                    change({
                      ...workflow,
                      inputs: renamed(workflow.inputs, name, next),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() =>
                    change({
                      ...workflow,
                      inputs: without(workflow.inputs, name),
                    })
                  }
                >
                  Remove input {name}
                </Button>
              </div>
              <TypeEditor
                value={input.type}
                onChange={(type) =>
                  change({
                    ...workflow,
                    inputs: { ...workflow.inputs, [name]: { ...input, type } },
                  })
                }
              />
              <Field label="Input description">
                <input
                  value={input.description ?? ''}
                  onChange={(e) =>
                    change({
                      ...workflow,
                      inputs: {
                        ...workflow.inputs,
                        [name]: { ...input, description: e.target.value },
                      },
                    })
                  }
                />
              </Field>
              <label className="wf-check">
                <input
                  type="checkbox"
                  checked={'default' in input}
                  disabled={
                    !ordinary(input.type) &&
                    !('nullable' in input.type && input.type.nullable)
                  }
                  onChange={(e) => {
                    const next = { ...input }
                    if (e.target.checked)
                      next.default = ordinary(input.type)
                        ? defaultValue(input.type)
                        : null
                    else delete next.default
                    change({
                      ...workflow,
                      inputs: { ...workflow.inputs, [name]: next },
                    })
                  }}
                />
                Provide a default
              </label>
              {input.default !== undefined && (
                <LiteralEditor
                  label={`${name} default`}
                  value={input.default}
                  type={input.type}
                  onChange={(value) =>
                    change({
                      ...workflow,
                      inputs: {
                        ...workflow.inputs,
                        [name]: { ...input, default: value },
                      },
                    })
                  }
                />
              )}
              <Issues
                path={pointer('/inputs', name)}
                diagnostics={diagnostics}
              />
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onPress={() => {
              const name = uniqueName('input', Object.keys(workflow.inputs))
              change({
                ...workflow,
                inputs: {
                  ...workflow.inputs,
                  [name]: { type: { kind: 'string' } },
                },
              })
            }}
          >
            Add Input
          </Button>
        </section>
        <section aria-label="Workflow steps">
          <div className="section-heading">
            <h2>Steps</h2>
            <span className="muted">
              {workflow.body.steps.length} steps · in order
            </span>
          </div>
          <SequenceEditor
            workflow={workflow}
            catalogs={catalogs}
            client={client}
            diagnostics={diagnostics}
            onChange={change}
          />
        </section>
        <section className="wf-section" aria-label="Workflow outputs">
          <div className="section-heading">
            <h2>Outputs</h2>
            <span className="muted">
              Published after the selected steps succeed
            </span>
          </div>
          {Object.entries(workflow.outputs).map(([name, output]) => (
            <div
              className="wf-port"
              key={name}
              data-ir-path={pointer('/outputs', name)}
            >
              <div className="wf-row">
                <NameField
                  label="Output name"
                  value={name}
                  names={Object.keys(workflow.outputs)}
                  onChange={(next) =>
                    change({
                      ...workflow,
                      outputs: renamed(workflow.outputs, name, next),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    change({
                      ...workflow,
                      outputs: without(workflow.outputs, name),
                    })
                  }
                >
                  Remove output {name}
                </Button>
              </div>
              <TypeEditor
                value={output.type}
                onChange={(type) =>
                  change({
                    ...workflow,
                    outputs: {
                      ...workflow.outputs,
                      [name]: { ...output, type },
                    },
                  })
                }
              />
              <Field label="Output description">
                <input
                  value={output.description ?? ''}
                  onChange={(e) =>
                    change({
                      ...workflow,
                      outputs: {
                        ...workflow.outputs,
                        [name]: { ...output, description: e.target.value },
                      },
                    })
                  }
                />
              </Field>
              <ExpressionEditor
                label={name}
                value={output.value}
                expected={output.type}
                path={pointer(pointer('/outputs', name), 'value')}
                context={{
                  workflow,
                  client,
                  before: workflow.body.steps.length,
                  diagnostics,
                }}
                onChange={(value) =>
                  change({
                    ...workflow,
                    outputs: {
                      ...workflow.outputs,
                      [name]: {
                        ...output,
                        value: value ?? initialExpression(output.type),
                      },
                    },
                  })
                }
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            onPress={() => {
              const name = uniqueName('output', Object.keys(workflow.outputs))
              change({
                ...workflow,
                outputs: {
                  ...workflow.outputs,
                  [name]: {
                    type: { kind: 'string' },
                    value: { kind: 'literal', value: '' },
                  },
                },
              })
            }}
          >
            Add Output
          </Button>
        </section>
      </fieldset>
      <section
        className="wf-validation wf-section"
        aria-label="Workflow validation"
      >
        <div className="section-heading">
          <h2>Validation</h2>
          <Button
            variant="secondary"
            disabled={!client}
            onPress={() => {
              void client
                ?.validate(source)
                .then((result) => {
                  setValidation(result)
                  setValidatedSource(source)
                })
                .catch((error) => setError(error.message))
            }}
          >
            Validate workflow
          </Button>
        </div>
        <p role="status">
          {valid
            ? `Valid Aixand IR v${workflow.ir_version}`
            : !client
              ? 'Connect to validate with Aixand IR.'
              : validatedSource !== source && !fileError
                ? 'Checking workflow…'
                : `${diagnostics.filter((d) => d.severity === 'error').length} validation error(s)`}
        </p>
        <ul>
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button
                className="wf-diagnostic-link"
                onClick={() => {
                  const elements = [
                    ...document.querySelectorAll<HTMLElement>('[data-ir-path]'),
                  ]
                    .filter(
                      (el) =>
                        d.location === el.dataset.irPath ||
                        d.location.startsWith(`${el.dataset.irPath}/`)
                    )
                    .sort(
                      (a, b) =>
                        (b.dataset.irPath?.length ?? 0) -
                        (a.dataset.irPath?.length ?? 0)
                    )
                  const element = elements[0]
                  element?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                  })
                  element
                    ?.querySelector<HTMLElement>('input,select,textarea,button')
                    ?.focus()
                }}
              >
                <strong>{(d.invocation_id ?? d.location) || 'Workflow'}</strong>{' '}
                · {d.code}: {d.message}
                <small>{d.location}</small>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <RunPanel
        workflow={workflow}
        source={source}
        valid={valid}
        client={client}
        onRunning={setRunning}
      />
      <details className="wf-section">
        <summary>Inspect workflow IR</summary>
        <pre aria-label="Current workflow IR">
          {JSON.stringify(workflow, null, 2)}
        </pre>
      </details>
    </div>
  )
}
