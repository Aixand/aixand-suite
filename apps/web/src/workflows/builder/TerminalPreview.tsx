import { createContext, useEffect, useRef, useState } from 'react'
import { Button, Dialog } from 'bbb-design'
import { AgentsConnection } from '../../agents/client'
import { TerminalConnection } from '../../terminals/connection'
import { PaneRuntime } from '../../terminals/pane-runtime'
import { WorkspaceTheme } from '../../branding/ContentTheme'
import type { PaneState } from '../../terminals/pane-runtime'
import { createCanvasId } from './model'
import type { WorkflowNode } from './model'
import type { TerminalTarget } from './terminals'
import '@xterm/xterm/css/xterm.css'

export const TerminalPreviewContext = createContext<(id: string) => void>(() => {})

export function TerminalPreview({ node, target, close, edit }: {
  node: WorkflowNode
  target?: TerminalTarget
  close: () => void
  edit: () => void
}) {
  const opener = useRef(document.activeElement)
  useEffect(() => () => {
    const element = opener.current
    requestAnimationFrame(() => {
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    })
  }, [])
  return (
    <WorkspaceTheme><Dialog
      className="wb-terminal-modal"
      bodyClassName="wb-terminal-modal-body"
      title={`Terminal · ${node.data.label}`}
      description="Read-only preview"
      open
      onOpenChange={(open) => { if (!open) close() }}
      closeLabel="Close terminal preview"
      trigger={<button hidden aria-label="Open terminal preview" />}
      footer={<Button variant="secondary" size="sm" onPress={edit}>Edit step</Button>}
    >
      {!target ? (
        <div className="wb-terminal-empty">
          <p>No terminal yet</p>
          <span>Run this workflow to preview the agent’s terminal.</span>
        </div>
      ) : !target.sessionId && !target.runId ? (
        <div className="wb-terminal-empty" role="status">
          <p>Waiting for this agent to spawn…</p>
          <span>The preview will open automatically when its terminal is ready.</span>
        </div>
      ) : (
        <PreviewStream key={target.sessionId ?? target.runId} target={target} label={node.data.label} />
      )}
    </Dialog></WorkspaceTheme>
  )
}

function PreviewStream({ target, label }: {
  target: TerminalTarget
  label: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<PaneRuntime | null>(null)
  const [state, setState] = useState<PaneState>({ phase: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    let terminalClient: TerminalConnection | null = null
    let agentClient: AgentsConnection | null = null
    let pane: PaneRuntime | null = null
    setState({ phase: 'connecting' })
    const failed = (cause: unknown) => {
      if (!disposed) setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    }
    function attach(sessionId: string) {
      if (disposed || !host.current) return
      pane = new PaneRuntime(host.current, createCanvasId(), {
        id: sessionId, name: label, lifecycle: { state: 'running' },
      }, (value) => { if (!disposed) setState(value) }, true)
      runtime.current = pane
      terminalClient = new TerminalConnection(() => {
        if (!disposed) void pane!.connect(terminalClient)
      }, () => {}, (message) => failed(new Error(message)))
    }
    if (target.sessionId) attach(target.sessionId)
    else {
      // Older retained jobs have run IDs in their final result, but no live
      // session events. Resolve that exact run through Agent Manager once.
      agentClient = new AgentsConnection(() => {
        void agentClient!.request<{ session_id: string }>('get', {
          provider: target.provider, runId: target.runId,
        }).then((agent) => {
          if (!agent.session_id) throw new Error('This agent has no retained terminal.')
          attach(agent.session_id)
          agentClient?.close()
        }).catch(failed)
      }, (message) => failed(new Error(message)))
    }
    return () => {
      disposed = true
      pane?.dispose()
      runtime.current = null
      terminalClient?.close()
      agentClient?.close()
    }
  }, [target.sessionId, target.runId, target.provider, label, attempt])
  return (
    <div className="wb-terminal-preview">
      <div className="wb-terminal-status" role="status">
        <span className={`wb-terminal-dot wb-terminal-dot--${state.phase}`} />
        <span>{state.phase === 'live' ? 'Following terminal output' : state.phase === 'connecting' ? 'Connecting to terminal…' : 'Preview disconnected'}</span>
        {state.phase === 'error' && <Button variant="ghost" size="sm" onPress={() => setAttempt((value) => value + 1)}>Reconnect preview</Button>}
      </div>
      {(state.phase === 'error' || state.phase === 'gap') && (
        <div className="wb-terminal-error" role="alert">
          <span>{state.message}</span>
          {state.phase === 'gap' && <Button variant="secondary" size="sm" onPress={() => void runtime.current?.attach(true)}>Restore current screen</Button>}
        </div>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      <div className="wb-terminal-viewport" role="region" aria-label={`Terminal output for ${label}`}>
        <div ref={host} className="wb-terminal-screen" />
      </div>
    </div>
  )
}
