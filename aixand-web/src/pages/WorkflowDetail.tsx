import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Dialog,
  Icon,
  PageHeader,
  Progress,
  TextField,
} from 'bbb-design'
import { statusTone } from '../model'
import type { Workflow } from '../model'

type Patch = Partial<Pick<Workflow, 'name' | 'steps' | 'status' | 'completed'>>
export function WorkflowDetail({
  workflow: w,
  onBack,
  onUpdate,
  onTerminal,
}: {
  workflow: Workflow
  onBack: () => void
  onUpdate: (patch: Patch) => void
  onTerminal: () => void
}) {
  const [selected, setSelected] = useState(0)
  return (
    <div className="page-stack">
      <div>
        <Button variant="ghost" size="sm" onPress={onBack}>
          <Icon name="chevron-left" /> All workflows
        </Button>
      </div>
      <PageHeader
        title={w.name}
        eyebrow="WORKFLOW OVERVIEW"
        description={w.prompt}
        actions={
          <>
            <Badge dot tone={statusTone(w.status)}>
              {w.status}
            </Badge>
            {w.status === 'Ready' && (
              <EditWorkflow workflow={w} onSave={onUpdate} />
            )}
            {w.status !== 'Completed' && (
              <Button
                onPress={() =>
                  onUpdate({
                    status: w.status === 'Running' ? 'Paused' : 'Running',
                  })
                }
              >
                <Icon name={w.status === 'Running' ? 'minus' : 'arrow-right'} />
                {w.status === 'Running'
                  ? 'Pause demo'
                  : w.status === 'Paused'
                    ? 'Resume demo'
                    : 'Start demo run'}
              </Button>
            )}
            {w.status === 'Completed' && (
              <Button
                variant="secondary"
                onPress={() => onUpdate({ completed: 0, status: 'Ready' })}
              >
                <Icon name="refresh-cw" /> Run again
              </Button>
            )}
          </>
        }
      />
      <div className="run-progress">
        <Progress
          label={`${w.completed} of ${w.steps.length} steps completed`}
          value={w.completed}
          max={w.steps.length}
        />
        <p role="status">
          {w.status === 'Running'
            ? 'Demo running · one step completes every six seconds.'
            : w.status === 'Completed'
              ? 'Demo complete. All steps finished.'
              : w.status === 'Paused'
                ? 'Demo paused. Resume when you’re ready.'
                : 'Review your plan, then start a demo run.'}
        </p>
      </div>
      <section className="workflow-canvas" aria-labelledby="plan-heading">
        <div className="section-heading">
          <h2 id="plan-heading">The plan</h2>
          <span className="muted">{w.steps.length} connected steps</span>
        </div>
        <ol className="graph-steps">
          {w.steps.map((step, index) => (
            <li
              key={index}
              data-state={
                index < w.completed
                  ? 'complete'
                  : index === w.completed && w.status === 'Running'
                    ? 'running'
                    : 'waiting'
              }
            >
              <Button
                variant="ghost"
                className="graph-node"
                aria-pressed={selected === index}
                onPress={() => setSelected(index)}
              >
                <span className="node-number">
                  {index < w.completed ? (
                    <Icon name="check" />
                  ) : (
                    String(index + 1).padStart(2, '0')
                  )}
                </span>
                <strong>{step}</strong>
                <span>
                  {index < w.completed
                    ? 'Completed'
                    : index === w.completed && w.status === 'Running'
                      ? 'In progress'
                      : 'Pending'}
                </span>
              </Button>
            </li>
          ))}
        </ol>
        <p className="canvas-caption">
          <Icon name="mouse-pointer" /> Select a step to see its details.
        </p>
      </section>
      <div className="detail-grid">
        <Card
          title={w.steps[selected]}
          description={`Step ${selected + 1} of ${w.steps.length}`}
        >
          <p>
            {selected < w.completed
              ? 'This step completed successfully in the demo.'
              : selected === w.completed && w.status === 'Running'
                ? 'This step is being simulated. Its output will appear when it completes.'
                : 'This step will run after its preceding steps complete.'}
          </p>
          <div className="detail-meta">
            <span>Execution</span>
            <strong>Local simulation</strong>
          </div>
          <div className="detail-meta">
            <span>Depends on</span>
            <strong>
              {selected === 0 ? 'No dependencies' : w.steps[selected - 1]}
            </strong>
          </div>
        </Card>
        <Card
          title="Execution activity"
          description="Follow your workflow, one step at a time."
          action={
            <Button variant="ghost" size="sm" onPress={onTerminal}>
              Open terminal <Icon name="arrow-right" />
            </Button>
          }
        >
          <ul className="activity-list">
            <li>
              <span className="activity-dot" />
              Workflow plan created
            </li>
            {w.steps.slice(0, w.completed).map((step, i) => (
              <li key={i}>
                <Icon name="check" />
                {step} completed
              </li>
            ))}
            {w.status === 'Running' && (
              <li>
                <span className="activity-dot" />
                {w.steps[w.completed]} in progress
              </li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function EditWorkflow({
  workflow,
  onSave,
}: {
  workflow: Workflow
  onSave: (patch: Patch) => void
}) {
  const [name, setName] = useState(workflow.name)
  const [steps, setSteps] = useState(workflow.steps)
  return (
    <Dialog
      title="Make the plan yours"
      description="Give it a name and refine the steps before running."
      trigger={<Button variant="secondary">Edit plan</Button>}
      onOpenChange={(open) => {
        if (open) {
          setName(workflow.name)
          setSteps(workflow.steps)
        }
      }}
    >
      {(close) => (
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || steps.some((s) => !s.trim())) return
            onSave({ name: name.trim(), steps: steps.map((s) => s.trim()) })
            close()
          }}
        >
          <TextField
            label="Workflow name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {steps.map((step, i) => (
            <TextField
              key={i}
              label={`Step ${i + 1}`}
              value={step}
              required
              maxLength={100}
              onChange={(e) =>
                setSteps((current) =>
                  current.map((s, index) => (index === i ? e.target.value : s)),
                )
              }
            />
          ))}
          <div className="form-actions">
            <Button variant="secondary" onPress={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || steps.some((s) => !s.trim())}
            >
              Save plan
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}
