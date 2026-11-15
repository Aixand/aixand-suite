import { Badge, Button, EmptyState, Icon } from 'bbb-design'
import { formatDate, statusTone } from '../model'
import type { Workflow } from '../model'

export function WorkflowList({
  workflows,
  onOpen,
}: {
  workflows: Workflow[]
  onOpen: (id: string) => void
}) {
  if (!workflows.length)
    return (
      <EmptyState
        icon="search"
        title="No workflows found"
        description="Try another name or change the status filter."
      />
    )
  return (
    <ul className="workflow-list">
      {workflows.map((w) => (
        <li key={w.id}>
          <span
            className={`workflow-symbol ${w.status === 'Completed' ? 'workflow-symbol--done' : ''}`}
          >
            <Icon name={w.status === 'Completed' ? 'check' : 'layers'} />
          </span>
          <div className="workflow-copy">
            <Button
              className="workflow-link"
              variant="ghost"
              onPress={() => onOpen(w.id)}
            >
              {w.name}
            </Button>
            <p>
              {w.steps.length} steps <span aria-hidden="true">·</span>{' '}
              {w.template}
            </p>
          </div>
          <Badge dot tone={statusTone(w.status)}>
            {w.status}
          </Badge>
          <time className="workflow-date" dateTime={w.createdAt}>
            {formatDate(w.createdAt)}
          </time>
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            aria-label={`Open ${w.name}`}
            onPress={() => onOpen(w.id)}
          >
            <Icon name="chevron-right" />
          </Button>
        </li>
      ))}
    </ul>
  )
}
