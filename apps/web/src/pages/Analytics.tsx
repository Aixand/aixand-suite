import { Badge, Card, PageHeader, Progress } from 'bbb-design'
import type { CSSProperties } from 'react'
import type { Workflow } from '../model'

export function Analytics({ workflows }: { workflows: Workflow[] }) {
  const completed = workflows.filter((w) => w.status === 'Completed').length
  const steps = workflows.reduce((sum, w) => sum + w.completed, 0)
  const totalSteps = workflows.reduce((sum, w) => sum + w.steps.length, 0)
  const statuses = ['Ready', 'Running', 'Paused', 'Completed'] as const
  return (
    <div className="page-stack">
      <PageHeader
        title="Analytics"
        eyebrow="YOUR WORKSPACE"
        description="See what’s moving forward and what needs your attention."
        actions={<Badge>Local demo data</Badge>}
      />
      <div className="stats-strip analytics-stats">
        {[
          ['Workflows', workflows.length],
          ['Completed', completed],
          ['Steps finished', steps],
          [
            'Completion rate',
            `${workflows.length ? Math.round((completed / workflows.length) * 100) : 0}%`,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="analytics-grid">
        <Card
          title="Where the work stands"
          description="Current workflow counts by status."
        >
          <div className="bar-chart">
            {statuses.map((status) => {
              const count = workflows.filter((w) => w.status === status).length
              return (
                <div className="chart-column" key={status}>
                  <strong>{count}</strong>
                  <div className="bar-track">
                    <div
                      className={`chart-bar chart-bar--${status.toLowerCase()}`}
                      style={
                        {
                          '--bar-height': `${(count / Math.max(1, ...statuses.map((s) => workflows.filter((w) => w.status === s).length))) * 100}%`,
                        } as CSSProperties
                      }
                    />
                  </div>
                  <span>{status}</span>
                </div>
              )
            })}
          </div>
        </Card>
        <Card
          title="One step at a time"
          description="Progress across all your workflow plans."
        >
          <div className="completion-number">
            {steps}
            <span> / {totalSteps}</span>
          </div>
          <Progress
            label="Steps completed"
            value={steps}
            max={totalSteps || 1}
          />
          <p className="muted">
            Every finished step brings an idea closer to reality.
          </p>
        </Card>
      </div>
      <Card
        title="Progress by workflow"
        description="Your workspace at a glance."
      >
        <div className="workflow-progress-list">
          {workflows.length ? (
            workflows.map((w) => (
              <Progress
                key={w.id}
                label={w.name}
                value={w.completed}
                max={w.steps.length}
              />
            ))
          ) : (
            <p>No workflows yet. Create a plan to get started.</p>
          )}
        </div>
      </Card>
      <p className="muted small">
        Metrics are calculated from this browser’s demo workflows. Production
        usage, duration, and cost data will require a backend connection.
      </p>
    </div>
  )
}
