import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  Button,
  Icon,
  DropdownMenu,
} from 'bbb-design'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  MarkerType,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import type {
  Connection,
  EdgeChange,
  NodeChange,
  OnSelectionChangeFunc,
} from '@xyflow/react'
import {
  arrangeNodes,
  checkGraph,
  connectionAllowed,
  createCanvasId,
  hasAgentTerminal,
  sequentialDraft,
  projectAuditDraft,
  makeNode,
  parseDraft,
  serializeDraft,
} from '../workflows/builder/model'
import type {
  CanvasDraft,
  NodeKind,
  StepData,
  WorkflowNode,
} from '../workflows/builder/model'
import { BuilderIcon } from '../workflows/builder/StepNode'
import { Inspector } from '../workflows/builder/Inspector'
import { NodeMenu } from '../workflows/builder/NodeMenu'
import { NewWorkflow } from '../workflows/NewWorkflow'
import type { SavedWorkflow, WorkflowTemplate } from '../workflows/library'
import type { NodeMenuPosition } from '../workflows/builder/NodeMenu'
import { compileSequence } from '../workflows/builder/compile'
import { compileCanvas } from '../workflows/builder/compileCanvas'
import { ExecutionPanel } from '../workflows/builder/ExecutionPanel'
import { TerminalPreview, TerminalPreviewContext } from '../workflows/builder/TerminalPreview'
import {
  RunStatusContext,
  useWorkflowRun,
} from '../workflows/builder/useWorkflowRun'
import '@xyflow/react/dist/style.css'
import '../workflows/builder/builder.css'

import { WorkflowCanvas } from '../workflows/builder/WorkflowCanvas'
import { WorkflowToolbar } from '../workflows/builder/WorkflowToolbar'
import { NativeRunBuilder } from '../workflows/builder/NativeRunBuilder'
import type { NativeRunBuilderProps } from '../workflows/builder/NativeRunBuilder'
import type { AgentsModel } from '../agents/model'
import type { Workspace } from '../workspace/model'
import { RunNodeContext } from '../workflows/builder/RunNodeContext'
import type { ExistingRun } from '../workflows/builder/useWorkflowRun'
type BuilderProps = {
  agents?: AgentsModel
  workspace?: Workspace
  navigate?: (route: string) => void
  workflow: SavedWorkflow
  onSave: (id: string, draft: CanvasDraft) => void
  create: (name: string, template?: WorkflowTemplate) => string
  onCreated: (id: string) => void
  onBack: () => void
  storageError: string
  notice: string
  existingRun?: ExistingRun
}
export function WorkflowBuilder(props: BuilderProps | NativeRunBuilderProps) {
  return (
    <ReactFlowProvider>
      {'mode' in props ? <NativeRunBuilder {...props} /> : <Builder {...props} />}
    </ReactFlowProvider>
  )
}

function Builder({ workflow, onSave, create, onCreated, onBack, storageError, notice: initialNotice, agents, workspace, navigate, existingRun }: BuilderProps) {
  const [draft, setDraft] = useState(workflow.draft)
  const native = draft.nodes.some((node) => ['chat', 'collector', 'human-inbox'].includes(node.data.kind))
  const [notice, setNotice] = useState(initialNotice)
  const [storageErrorDismissed, setStorageErrorDismissed] = useState(false)
  useEffect(() => setStorageErrorDismissed(false), [storageError])
  const [panel, setPanel] = useState<'settings' | 'run' | null>(null)
  const run = useWorkflowRun(draft, workflow.id, workspace, navigate, existingRun)
  const [editingRun, setEditingRun] = useState(!!existingRun)
  const acceptedCanvas = useRef(workflow.draft)
  const acceptedRevision = useRef<number | undefined>(undefined)
  const locked = new Set(editingRun ? run.plan?.locked_groups ?? [] : [])
  useEffect(() => { if (run.mutable && run.snapshot) setEditingRun(true) }, [run.mutable, run.snapshot?.key])
  useEffect(() => {
    if (!run.plan?.authoring || acceptedRevision.current === run.plan.revision) return
    const semantic = (canvas: CanvasDraft) => JSON.stringify({ name: canvas.name, native: canvas.native,
      nodes: canvas.nodes.map((node) => [node.id, node.data]), edges: canvas.edges.map((edge) => [edge.source, edge.target, edge.sourceHandle, edge.targetHandle]) })
    if (semantic(draft) === semantic(acceptedCanvas.current)) setDraft(run.plan.authoring)
    acceptedCanvas.current = run.plan.authoring
    acceptedRevision.current = run.plan.revision
  }, [run.plan, draft])
  const execution = useMemo(() => {
    try {
      const compiled = run.snapshot && !('format' in run.snapshot.workflow)
        ? compileSequence(draft, run.snapshot.namespace) // Match a retained historical submission without rewriting it.
        : compileCanvas(draft, run.snapshot?.namespace, run.snapshot && 'format' in run.snapshot.workflow ? run.snapshot.workflow.version : 2,
          run.snapshot && 'format' in run.snapshot.workflow ? run.snapshot.workflow.identities : undefined)
      if (run.snapshot && 'format' in run.snapshot.workflow && 'format' in compiled.workflow) compiled.workflow.context = run.snapshot.workflow.context
      return { compiled, problem: '' }
    } catch (cause) {
      return { compiled: null, problem: (cause as Error).message }
    }
  }, [draft, run.snapshot?.namespace])
  const runMatchesDraft =
    execution.compiled &&
    JSON.stringify(execution.compiled.workflow) ===
      JSON.stringify(run.snapshot?.workflow)
  const runStates = run.states
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null)
  const previewNode = draft.nodes.find((node) => node.id === previewNodeId)
  const [nodeMenu, setNodeMenu] = useState<NodeMenuPosition | null>(null)
  const longPressOpened = useRef(false)
  const touchPress = useRef<{
    x: number
    y: number
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>(
    {},
  )
  const [checked, setChecked] = useState(false)
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 })
  const history = useRef<{ past: CanvasDraft[]; future: CanvasDraft[] }>({
    past: [],
    future: [],
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const flow = useReactFlow<WorkflowNode>()
  const source = useMemo(() => serializeDraft(draft), [draft])
  const savedSource = useRef(source)
  const issues = useMemo(
    () => checkGraph(draft.nodes, draft.edges),
    [draft.nodes, draft.edges],
  )
  const selectedNode = draft.nodes.find((node) => node.id === selection.node)
  const selectedEdge = draft.edges.find((edge) => edge.id === selection.edge)
  const onSelectionChange = useCallback<OnSelectionChangeFunc<WorkflowNode>>(
    ({ nodes, edges }) => {
      const next = nodes.length
        ? { node: nodes[0].id }
        : edges.length
          ? { edge: edges[0].id }
          : {}
      setSelection((current) =>
        current.node === next.node && current.edge === next.edge
          ? current
          : next,
      )
    },
    [],
  )

  useEffect(() => {
    if (editingRun && run.snapshot) return
    if (savedSource.current === source) return
    try {
      onSave(workflow.id, draft)
      savedSource.current = source
    } catch {
      setNotice(
        'Browser storage is unavailable. Export your workflow to keep your changes.',
      )
    }
  }, [source, draft, onSave, workflow.id, editingRun, run.snapshot?.key])

  const closeNodeMenu = useCallback((restoreFocus = false) => {
    setNodeMenu(null)
    if (restoreFocus) canvasRef.current?.focus({ preventScroll: true })
  }, [])
  function openNodeMenu(clientX: number, clientY: number) {
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!bounds) return
    setNodeMenu({
      anchor: { x: clientX - bounds.left, y: clientY - bounds.top },
      point: flow.screenToFlowPosition({ x: clientX, y: clientY }),
      bounds: { width: bounds.width, height: bounds.height },
    })
  }
  function addMenuAt(event: {
    preventDefault: () => void
    clientX: number
    clientY: number
  }) {
    event.preventDefault()
    cancelTouchPress()
    openNodeMenu(event.clientX, event.clientY)
  }
  function cancelTouchPress() {
    if (touchPress.current) clearTimeout(touchPress.current.timer)
    touchPress.current = null
  }
  useEffect(() => cancelTouchPress, [])

  function checkpoint() {
    history.current.past = [...history.current.past.slice(-39), draft]
    history.current.future = []
    setHistorySize({ past: history.current.past.length, future: 0 })
  }
  function changesStartedStep(next: CanvasDraft) {
    if (editingRun && locked.size) {
      const accepted = run.plan?.authoring ?? run.snapshot?.authoring ?? draft
      for (const id of locked) {
        const before = accepted.nodes.find((node) => node.id === id)
        const after = next.nodes.find((node) => node.id === id)
        const links = (canvas: CanvasDraft) => canvas.edges.filter((edge) => edge.target === id || edge.source === id && edge.sourceHandle === 'tools')
          .map((edge) => [edge.source, edge.target, edge.sourceHandle, edge.targetHandle]).sort()
        if (!after || before && JSON.stringify(before.data) !== JSON.stringify(after.data) || JSON.stringify(links(accepted)) !== JSON.stringify(links(next))) {
          return true
        }
      }
    }
    return false
  }
  function commit(next: CanvasDraft) {
    if (changesStartedStep(next)) {
      setNotice('This step has started. Add work after it or edit a pending step.'); return
    }
    checkpoint()
    setDraft(next)
    setChecked(false)
  }
  function undo(redo = false) {
    const from = redo ? history.current.future : history.current.past
    const to = redo ? history.current.past : history.current.future
    const next = from.at(-1)
    if (!next) return
    if (changesStartedStep(next)) {
      setNotice('This step has started. Add work after it or edit a pending step.'); return
    }
    from.pop()
    to.push(draft)
    setDraft(next)
    setSelection({})
    setChecked(false)
    setHistorySize({
      past: history.current.past.length,
      future: history.current.future.length,
    })
  }
  function replace(next: CanvasDraft) {
    commit(next)
    setSelection({})
    setPanel(null)
    setNodeMenu(null)
    requestAnimationFrame(() => {
      void flow.fitView({ padding: 0.16, duration: 200, maxZoom: 1 })
    })
  }
  function addStep(kind: NodeKind, point: { x: number; y: number }) {
    if (draft.nodes.length >= 100) {
      setNotice('This workflow supports up to 100 steps.')
      closeNodeMenu(true)
      return
    }
    const node = makeNode(kind, point)
    commit({
      ...draft,
      nodes: [
        ...draft.nodes.map((step) => ({ ...step, selected: false })),
        { ...node, selected: true },
      ],
    })
    setSelection({ node: node.id })
    closeNodeMenu(true)
  }
  function updateNode(data: Partial<StepData>) {
    commit({
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === selection.node
          ? { ...node, data: { ...node.data, ...data } }
          : node,
      ),
    })
  }
  function addAfterSelected(insert: boolean) {
    if (!selectedNode || ['done', 'human-inbox', 'tool'].includes(selectedNode.data.kind)) return
    const outgoing = draft.edges.filter((edge) => edge.source === selectedNode.id && edge.sourceHandle !== 'tools')
    if (insert && outgoing.some((edge) => locked.has(edge.target))) { setNotice('A dependent step has started. Add a separate dependent task.'); return }
    const node = makeNode(run.needsProject ? 'chat' : 'agent', { x: selectedNode.position.x + 100, y: selectedNode.position.y + 230 }, 'Next task')
    node.data.prompt = 'Complete the next task using the supplied results.'
    let edges = insert ? draft.edges.filter((edge) => !outgoing.includes(edge)) : draft.edges
    const link = (source: string, target: string) => ({ id: createCanvasId(), source, target, sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' })
    edges = [...edges, link(selectedNode.id, node.id)]
    if (insert && outgoing.length) edges.push(...outgoing.map((edge) => ({ ...edge, source: node.id })))
    else {
      const terminals = draft.nodes.filter((entry) => ['done', 'result', 'human-inbox'].includes(entry.data.kind) && !locked.has(entry.id)
        && !draft.edges.some((edge) => edge.source === entry.id && edge.sourceHandle !== 'tools'))
      if (!terminals.length) { setNotice('Final work has started. Schedule a follow-up workflow instead.'); return }
      edges.push(...terminals.map((entry) => link(node.id, entry.id)))
    }
    commit({ ...draft, nodes: [...draft.nodes, node], edges })
    setSelection({ node: node.id }); setPanel('settings')
  }
  function removeSelected() {
    commit({
      ...draft,
      nodes: draft.nodes.filter((node) => node.id !== selection.node),
      edges: draft.edges.filter(
        (edge) =>
          edge.id !== selection.edge &&
          edge.source !== selection.node &&
          edge.target !== selection.node,
      ),
    })
    setSelection({})
  }
  function duplicateSelected() {
    if (!selectedNode || draft.nodes.length >= 100) return
    const node = {
      ...makeNode(selectedNode.data.kind, {
        x: selectedNode.position.x + 70,
        y: selectedNode.position.y + 70,
      }),
      data: { ...selectedNode.data, label: `${selectedNode.data.label} copy` },
      selected: true,
    }
    commit({
      ...draft,
      nodes: [
        ...draft.nodes.map((step) => ({ ...step, selected: false })),
        node,
      ],
    })
    setSelection({ node: node.id })
  }
  const onNodesChange = (changes: NodeChange<WorkflowNode>[]) => {
    setDraft((current) => {
      const next = {
      ...current,
      nodes: applyNodeChanges(changes, current.nodes),
      edges: current.edges.filter(
        (edge) =>
          !changes.some(
            (change) =>
              change.type === 'remove' &&
              (change.id === edge.source || change.id === edge.target),
          ),
      ),
      }
      return changesStartedStep(next) ? current : next
    })
  }
  const onEdgesChange = (changes: EdgeChange[]) => {
    setDraft((current) => {
      const next = {
      ...current,
      edges: applyEdgeChanges(changes, current.edges),
      }
      return changesStartedStep(next) ? current : next
    })
  }
  function connect(connection: Connection) {
    if (!connectionAllowed(connection, draft.nodes, draft.edges)) return
    if (draft.edges.length >= 500) {
      setNotice('This workflow supports up to 500 connections.')
      return
    }
    commit({
      ...draft,
      edges: addEdge(
        { ...connection, id: createCanvasId(), type: 'smoothstep' },
        draft.edges,
      ),
    })
  }
  function exportDraft() {
    const url = URL.createObjectURL(
      new Blob([source], { type: 'application/json' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${draft.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'workflow'}.canvas.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('Workflow exported.')
  }
  async function importDraft(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      if (file.size > 2 * 1024 * 1024)
        throw new Error('Choose a workflow smaller than 2 MB.')
      replace(parseDraft(await file.text()))
      setNotice('Workflow imported. Undo restores your previous workflow.')
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'This file could not be imported.',
      )
    }
  }

  return (
    <div
      className={`wb-builder${native ? ' wb-builder--native-draft' : ''} wb-builder--${panel ?? 'closed'}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          closeNodeMenu(true)
          setPanel(null)
          setSelection({})
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'z' &&
          !(
            event.target instanceof HTMLElement &&
            (event.target.isContentEditable ||
              ['INPUT', 'TEXTAREA'].includes(event.target.tagName))
          )
        ) {
          event.preventDefault()
          undo(event.shiftKey)
        }
      }}
    >
      <WorkflowToolbar title={draft.name} status={storageError ? 'Not saved' : 'Saved locally'} onBack={onBack}>
          <NewWorkflow create={create} onCreated={onCreated}
            trigger={
              <Button variant="ghost" size="sm" iconOnly aria-label="New">
                <Icon name="file-text" />
              </Button>
            }
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Undo"
            disabled={!historySize.past}
            onPress={() => undo()}
          >
            <Icon name="chevron-left" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Redo"
            disabled={!historySize.future}
            onPress={() => undo(true)}
          >
            <Icon name="chevron-right" />
          </Button>
          <span className="wb-toolbar-divider" />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Settings"
            aria-pressed={panel === 'settings'}
            onPress={() => setPanel(panel === 'settings' ? null : 'settings')}
          >
            <Icon name="panel-left" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Arrange"
            onPress={() => {
              commit({
                ...draft,
                nodes: arrangeNodes(draft.nodes, draft.edges, { mode: 'dag' }),
              })
              requestAnimationFrame(() => {
                void flow.fitView({ padding: 0.16, duration: 200, maxZoom: 1 })
              })
            }}
          >
            <Icon name="layout-grid" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Check connections"
            onPress={() => {
              setChecked(true)
              setNotice('')
            }}
          >
            <Icon name="check" />
          </Button>
          <span className="wb-toolbar-divider" />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Import workflow"
            onPress={() => fileRef.current?.click()}
          >
            <Icon name="arrow-down" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Export workflow"
            onPress={exportDraft}
          >
            <Icon name="arrow-up" />
            <span className="wb-action-label">Export</span>
          </Button>
          <Button
            size="sm"
            aria-label="Run workflow"
            aria-pressed={panel === 'run'}
            onPress={() => setPanel(panel === 'run' ? null : 'run')}
          >
            <Icon name="arrow-right" />
            <span className="wb-action-label">Run</span>
          </Button>
          <DropdownMenu
            label="Workflow options"
            trigger={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="More workflow actions"
              >
                <Icon name="ellipsis" />
              </Button>
            }
            items={[
              {
                id: 'sequential',
                label: native ? 'Reset to project audit' : 'Reset to Sequential hello',
                leading: <Icon name="layers" />,
              },
            ]}
            onAction={() => {
              replace(native ? projectAuditDraft() : sequentialDraft())
              setNotice(
                `${native ? 'Project audit' : 'Sequential hello'} loaded. Undo restores your previous workflow.`,
              )
            }}
          />
      </WorkflowToolbar>
      {((storageError && !storageErrorDismissed) || notice) && (
        <div className="wb-notice" role={storageError && !storageErrorDismissed ? 'alert' : 'status'}>
          <Icon name="info" />
          <span>{storageError && !storageErrorDismissed ? storageError : notice}</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Dismiss notice"
            onPress={() => { setNotice(''); setStorageErrorDismissed(true) }}
          >
            <Icon name="x" />
          </Button>
        </div>
      )}
      <div className="wb-workspace">
        <div
          ref={canvasRef}
          className="wb-canvas"
          role="region"
          aria-label="Workflow canvas"
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              event.key === 'ContextMenu' ||
              (event.shiftKey && event.key === 'F10')
            ) {
              event.preventDefault()
              event.stopPropagation()
              const bounds = canvasRef.current?.getBoundingClientRect()
              if (bounds)
                openNodeMenu(
                  bounds.left + bounds.width / 2,
                  bounds.top + bounds.height / 2,
                )
            }
          }}
          onPointerDown={(event) => {
            if (
              event.pointerType !== 'touch' ||
              !(event.target instanceof Element) ||
              event.target.closest(
                '.react-flow__node, .react-flow__edge, .react-flow__controls, .wb-context-menu',
              )
            )
              return
            cancelTouchPress()
            const { clientX: x, clientY: y } = event
            touchPress.current = {
              x,
              y,
              timer: setTimeout(() => {
                touchPress.current = null
                openNodeMenu(x, y)
                longPressOpened.current = true
              }, 550),
            }
          }}
          onPointerMove={(event) => {
            if (
              touchPress.current &&
              Math.hypot(
                event.clientX - touchPress.current.x,
                event.clientY - touchPress.current.y,
              ) > 8
            )
              cancelTouchPress()
          }}
          onPointerUp={cancelTouchPress}
          onPointerCancel={cancelTouchPress}
        >
          <RunNodeContext.Provider value={runMatchesDraft ? run.details : run.legacy?.details ?? {}}>
          <TerminalPreviewContext.Provider value={setPreviewNodeId}>
          <RunStatusContext.Provider value={runStates}>
            <WorkflowCanvas
              nodes={draft.nodes}
              edges={draft.edges.map((edge) => edge.sourceHandle === 'tools' ? {
                ...edge, label: edge.label || 'Optional · request / reply',
                markerStart: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
                markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
                style: { strokeWidth: 1.5, strokeDasharray: '6 5' },
              } : edge)}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={connect}
              isValidConnection={(connection) =>
                connectionAllowed(connection, draft.nodes, draft.edges)
              }
              onNodeClick={(_event, node) => {
                setSelection({ node: node.id })
                if (hasAgentTerminal(node.data.kind) && runMatchesDraft && !editingRun) setPreviewNodeId(node.id)
                else setPanel('settings')
              }}
              onEdgeClick={(_event, edge) => {
                setSelection({ edge: edge.id })
                setPanel('settings')
              }}
              onSelectionChange={onSelectionChange}
              onPaneClick={() => {
                if (longPressOpened.current) {
                  longPressOpened.current = false
                  return
                }
                setSelection({})
                closeNodeMenu()
              }}
              onPaneContextMenu={addMenuAt}
              onNodeContextMenu={addMenuAt}
              onEdgeContextMenu={addMenuAt}
              onMoveStart={() => closeNodeMenu()}
              onNodeDragStart={checkpoint}
              onBeforeDelete={async () => {
                checkpoint()
                setChecked(false)
                return true
              }}
              deleteKeyCode={['Backspace', 'Delete']}
            />
          </RunStatusContext.Provider>
          </TerminalPreviewContext.Provider>
          </RunNodeContext.Provider>
          {nodeMenu && (
            <NodeMenu
              position={nodeMenu}
              add={(kind) => addStep(kind, nodeMenu.point)}
              close={closeNodeMenu}
            />
          )}
          {!draft.nodes.length && (
            <div className="wb-empty">
              <span className="wb-empty-icon">
                <BuilderIcon kind="workflow" />
              </span>
              <h2>A workflow starts with an idea</h2>
              <p>
                Right-click to add a node. Drag between its ports to connect
                steps.
              </p>
            </div>
          )}
          {checked && (
            <div
              className={`wb-check${issues.length ? ' wb-check--issues' : ''}`}
              role="status"
            >
              <div>
                <Icon name={issues.length ? 'triangle-alert' : 'check'} />
                <strong>
                  {issues.length
                    ? `${issues.length} connection${issues.length === 1 ? '' : 's'} to check`
                    : 'All steps are connected'}
                </strong>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Dismiss connection check"
                  onPress={() => setChecked(false)}
                >
                  <Icon name="x" />
                </Button>
              </div>
              {issues.length ? (
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${index}-${issue}`}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  Independent nodes run together. Required connections wait for completed outputs; adviser links are optional.
                </p>
              )}
            </div>
          )}
        </div>
        {panel === 'run' ? (
          <ExecutionPanel
            run={run}
            workspace={workspace}
            configure={(settings) => commit({ ...draft, native: settings })}
            editingRun={editingRun} setEditingRun={setEditingRun}
            saveDefinition={() => { onSave(workflow.id, draft); setNotice('Workflow saved for future runs.') }}
            dirty={!runMatchesDraft} navigate={navigate}
            restoreAccepted={() => { if (run.plan?.authoring) setDraft(run.plan.authoring) }}
            problem={execution.problem}
            close={() => setPanel(null)}
            resetWorkflow={() => {
              replace(sequentialDraft())
              setPanel('run')
            }}
          />
        ) : (
          <Inspector
            runtime={selectedNode ? run.details[selectedNode.id] : undefined}
            agents={agents}
            draft={draft}
            node={selectedNode}
            edge={selectedEdge}
            updateDraft={(data) => commit({ ...draft, ...data })}
            updateNode={updateNode}
            updateEdge={(label) =>
              commit({
                ...draft,
                edges: draft.edges.map((edge) =>
                  edge.id === selection.edge ? { ...edge, label } : edge,
                ),
              })
            }
            connect={connect}
            remove={removeSelected}
            duplicate={duplicateSelected}
            readOnly={!!selectedNode && locked.has(selectedNode.id)}
            addAfter={selectedNode && !['done', 'human-inbox', 'tool'].includes(selectedNode.data.kind) ? addAfterSelected : undefined}
            close={() => {
              setPanel(null)
              setSelection({})
            }}
          />
        )}
      </div>
      {previewNode && hasAgentTerminal(previewNode.data.kind) && (
        <TerminalPreview
          node={previewNode}
          target={runMatchesDraft ? run.terminals[previewNode.id] : undefined}
          close={() => setPreviewNodeId(null)}
          edit={() => {
            setPreviewNodeId(null)
            setSelection({ node: previewNode.id })
            setPanel('settings')
          }}
        />
      )}
      <footer className="wb-statusbar">
        <span>
          <span className="wb-status-dot" />
          {draft.nodes.length} nodes{' '}
          <span className="wb-status-separator">·</span> {draft.edges.length}{' '}
          connections <span className="wb-status-separator">·</span> Dependency graph
        </span>
        <span>
          Right-click to add a node{' '}
          <span className="wb-status-separator">·</span> Drag ports to connect
        </span>
      </footer>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        aria-label="Import canvas workflow"
        hidden
        onChange={(event) => {
          void importDraft(event)
        }}
      />
    </div>
  )
}
