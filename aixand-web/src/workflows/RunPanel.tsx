import { useState } from 'react'
import { Button } from 'bbb-design'
import { LiteralEditor } from './Fields'
import type { Failure, Json, RunEvent, Workflow } from './ir'
import { defaultValue, ordinary, without } from './ir'
import type { WorkflowConnection } from './client'
export function RunPanel({
  workflow,
  source,
  valid,
  client,
  onRunning,
}: {
  workflow: Workflow
  source: string
  valid: boolean
  client: WorkflowConnection | null
  onRunning: (running: boolean) => void
}) {
  const [inputs, setInputs] = useState<Record<string, Json>>({})
  const [events, setEvents] = useState<RunEvent[]>([])
  const [outputs, setOutputs] = useState<Record<string, Json> | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [running, setRunning] = useState(false)
  const [executedSource, setExecutedSource] = useState('')
  const start = () => {
    if (!client) return
    setEvents([])
    setOutputs(null)
    setFailure(null)
    setRunning(true)
    setExecutedSource(source)
    onRunning(true)
    try {
      const supplied = Object.fromEntries(
        Object.entries(inputs).filter(([name]) => name in workflow.inputs)
      )
      client.run(source, supplied, (message) => {
        if (message.event) setEvents((events) => [...events, message.event!])
        if (message.outputs !== undefined || message.failure) {
          setOutputs(message.outputs ?? null)
          setFailure(message.failure ?? null)
          setRunning(false)
          onRunning(false)
        }
      })
    } catch (error) {
      setFailure({ code: 'connection', message: (error as Error).message })
      setRunning(false)
      onRunning(false)
    }
  }
  return (
    <section className="wf-section" aria-label="Workflow execution">
      <div className="section-heading">
        <div>
          <h2>Run workflow</h2>
          <p>Execute the validated document using the connected runtime.</p>
        </div>
        <Button disabled={!valid || !client || running} onPress={start}>
          Run Workflow
        </Button>
      </div>
      <fieldset disabled={running} className="wf-fieldset">
        {Object.entries(workflow.inputs).map(([name, input]) => (
          <div key={name} className="wf-property">
            <label className="wf-check">
              <input
                type="checkbox"
                checked={name in inputs}
                disabled={!ordinary(input.type)}
                onChange={(e) =>
                  setInputs(
                    e.target.checked
                      ? {
                          ...inputs,
                          [name]:
                            input.default !== undefined
                              ? input.default
                              : defaultValue(input.type),
                        }
                      : without(inputs, name)
                  )
                }
              />
              Provide {name}
            </label>
            {name in inputs ? (
              <LiteralEditor
                label={`Run ${name}`}
                type={input.type}
                value={inputs[name]}
                onChange={(value) => setInputs({ ...inputs, [name]: value })}
              />
            ) : (
              <p className="wf-hint">
                {input.default !== undefined
                  ? `Default: ${JSON.stringify(input.default)}`
                  : ordinary(input.type)
                    ? 'Required for execution.'
                    : 'An opaque workflow interface needs an embedded host; it cannot be supplied as JSON.'}
              </p>
            )}
          </div>
        ))}
      </fieldset>
      {executedSource && executedSource !== source && (
        <p className="wf-hint">
          The results below belong to an earlier version of this draft.
        </p>
      )}
      {running && (
        <Button
          variant="secondary"
          onPress={() => {
            void client
              ?.request('cancel')
              .catch((error) =>
                setFailure({ code: 'cancel_request', message: error.message })
              )
          }}
        >
          Cancel run
        </Button>
      )}
      <ol className="wf-run-events" aria-label="Runner events">
        {events.map((event, index) => (
          <li key={index}>
            {event.event === 'prepared'
              ? 'Prepared'
              : event.event === 'started'
                ? `${event.invocation} · Running`
                : event.event === 'published'
                  ? `${event.invocation} · Completed`
                  : event.event === 'branch_evaluated'
                    ? `${event.invocation} · ${event.result ? 'true' : 'false'} · ${event.selected?.toUpperCase()} selected; ${event.selected === 'then' ? 'ELSE' : 'THEN'} skipped`
                    : event.event === 'completed'
                      ? 'Workflow body completed'
                      : `Operation failed: ${event.failure?.message}`}
          </li>
        ))}
      </ol>
      {outputs !== null && (
        <div role="status">
          <h3>Workflow completed</h3>
          <pre aria-label="Workflow run outputs">
            {JSON.stringify(outputs, null, 2)}
          </pre>
        </div>
      )}
      {failure && (
        <div role="alert" className="wf-issues">
          <h3>
            Execution failed
            {failure.invocation_id ? ` · ${failure.invocation_id}` : ''}
          </h3>
          <p>
            {failure.code}: {failure.message}
          </p>
          <details>
            <summary>Failure details</summary>
            <pre>{JSON.stringify(failure, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  )
}
