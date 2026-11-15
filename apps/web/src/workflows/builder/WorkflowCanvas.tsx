import { useThemeAttributes } from 'bbb-design'
import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow } from '@xyflow/react'
import type { Edge, ReactFlowProps } from '@xyflow/react'
import type { WorkflowNode } from './model'
import { StepNode } from './StepNode'

const nodeTypes = { workflowStep: StepNode }

/** Shared canvas for editable drafts and fixed submitted runs. */
export function WorkflowCanvas(props: ReactFlowProps<WorkflowNode, Edge>) {
  const theme = useThemeAttributes()
  return <ReactFlow<WorkflowNode, Edge>
    nodeTypes={nodeTypes}
    defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: 1.5 }, labelStyle: { fontSize: 11, fontWeight: 500 }, labelBgPadding: [6, 3], labelBgBorderRadius: 4 }}
    colorMode={theme['data-bbb-mode']} fitView fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
    minZoom={0.25} maxZoom={1.5} snapToGrid snapGrid={[10, 10]}
    aria-label="Workflow graph" nodesFocusable edgesFocusable {...props}>
    <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
    <Controls showInteractive={false} orientation="horizontal" />
    <MiniMap pannable zoomable ariaLabel="Workflow minimap" nodeColor="var(--bbb-color-border-strong)"
      maskColor="color-mix(in srgb, var(--bbb-color-canvas) 75%, transparent)" />
    {props.children}
  </ReactFlow>
}
