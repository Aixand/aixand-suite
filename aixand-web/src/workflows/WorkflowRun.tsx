import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState } from 'bbb-design'
import { WorkflowBuilder } from '../pages/WorkflowBuilder'
import { PageLoading } from '../components/PageLoading'
import type { Workspace } from '../workspace/model'
import type { useWorkflowLibrary } from './library'
import { openMainInbox } from '../carrier/navigation'

export function WorkflowRun({ runKey, workspace: w, navigate, library }: {
  runKey: string; workspace: Workspace; navigate: (route: string) => void;
  library: ReturnType<typeof useWorkflowLibrary>;
}) {
  const chats = useRef(w.chats)
  chats.current = w.chats
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const connected = w.agents.status === 'connected'
  const run = w.chats.workflowRuns.find((row) => row.key === runKey || row.id === runKey)
  useEffect(() => {
    let alive = true
    if (connected) {
      setLoading(true)
      void chats.current.openWorkflowRun(runKey).then(() => { if (alive) setError('') })
        .catch((cause: Error) => { if (alive) setError(cause.message) })
        .finally(() => { if (alive) setLoading(false) })
    } else setLoading(false)
    return () => { alive = false }
  }, [runKey, connected])
  function inbox() { openMainInbox(w, navigate, run?.delivery?.message_id) }
  if (!run && loading) return <PageLoading label="Loading workflow run…" />
  if (!run) return <div className="page-stack">
    {error && <p role="alert">{error}</p>}
    <EmptyState title={connected ? 'Workflow run unavailable' : 'Reconnect to view this workflow'}
      description="Saved runs are available from Workflows."
      action={<Button onPress={() => navigate('workflows')}>Back to workflows</Button>} />
  </div>
  if (run.id && run.canvas && run.executionWorkflow?.format === 'aixand.workflow-graph') {
    const workflowId = run.workflowId || `run-${run.id}`
    return <>
      {run.parentJobId && <Button variant="ghost" onPress={() => navigate(`workflows/runs/${run.parentJobId}`)}>Open previous workflow</Button>}
      <WorkflowBuilder workflow={{ id: workflowId, draft: run.canvas, createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }}
        existingRun={{ id: run.id, key: run.key, namespace: run.namespace || run.key, workflow: run.executionWorkflow, canvas: run.canvas }}
        workspace={w} agents={w.agents} navigate={navigate} storageError={library.storageError} notice={library.notice}
        onSave={(id, draft) => { if (library.workflows.some((row) => row.id === id)) library.save(id, draft)
          else { const saved = library.create(draft.name); library.save(saved, draft) } }}
        create={library.create} onCreated={(id) => navigate(`workflows/${id}`)} onBack={() => navigate('workflows')} />
    </>
  }
  return <WorkflowBuilder mode="run" run={run} connected={connected} error={error}
    onBack={() => navigate('workflows')} onOpenChat={(id) => navigate(`chat/${id}`)} onInbox={inbox}
    onOpenOrigin={w.chats.chats.some((chat) => chat.id === run.originChatId) ? () => navigate(`chat/${run.originChatId}`) : undefined}
    onAction={(action) => w.chats.workflowAction(run.originChatId, run.id ?? run.key, action)}
    workspace={w} navigate={navigate} />
}
