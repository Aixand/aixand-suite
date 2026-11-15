import { Button, Icon } from 'bbb-design'
import type { ReactNode } from 'react'
import { BuilderIcon } from './StepNode'

export function WorkflowToolbar({ title, status, onBack, children }: {
  title: string; status: string; onBack: () => void; children: ReactNode;
}) {
  return <header className="wb-toolbar">
    <div className="wb-title">
      <Button variant="ghost" size="sm" iconOnly aria-label="Back to workflows" onPress={onBack}><Icon name="chevron-left" /></Button>
      <BuilderIcon kind="workflow" /><h1 tabIndex={-1}>{title || 'Untitled workflow'}</h1>
      <span className="wb-save-status">{status}</span>
    </div>
    <div className="wb-toolbar-actions" role="group" aria-label="Workflow actions">{children}</div>
  </header>
}
