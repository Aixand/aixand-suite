import type { ReactNode } from 'react'
import { Badge, Button, EmptyState, Icon } from 'bbb-design'
import { CarrierListHeader } from './CarrierListHeader'
import type { DelegatedWorkModel } from './delegated'

const chatId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function ChatLink({ chat, label }: { chat: { id: string; title: string }; label: string }) {
  return <p>{label}: {chatId.test(chat.id) ? <a href={`#/chat/${chat.id}`}>{chat.title || chat.id}</a> : <span>{chat.title || 'Unavailable'}</span>}</p>
}

export function CarrierDelegatedList({ model: m, navigation, onSelect }: { model: DelegatedWorkModel; navigation?: ReactNode; onSelect: (id: string) => void }) {
  return <>
    <CarrierListHeader title="Delegated work" description="Task history and accepted reports" navigation={navigation}
      actions={<Button variant="ghost" size="sm" iconOnly aria-label="Refresh delegated work" disabled={m.listLoading} onPress={m.refresh}><Icon name="refresh-cw" /></Button>} />
    {m.listError && <div className="carrier-error" role="alert"><span>Delegated work could not be refreshed. {m.listError}</span><Button variant="ghost" size="sm" onPress={m.refresh}>Retry delegated work</Button></div>}
    <div className="carrier-message-scroll" aria-busy={m.listLoading}>
      {m.page.tasks.map(task => <Button key={task.taskId} variant="ghost" className="carrier-message-row" aria-pressed={m.selected === task.taskId} onPress={() => onSelect(task.taskId)}>
        <span className="carrier-row-top"><span className="carrier-row-sender">{task.provider} · {task.mode}</span></span>
        <span className="carrier-row-title">{task.title || task.taskId}</span>
        <span className="carrier-row-preview">Task status: {task.status}</span>
        <span className="carrier-row-preview">{task.reportAccepted ? 'Report accepted' : 'Report not accepted'}</span>
      </Button>)}
      {!m.page.tasks.length && !m.listLoading && !m.listError && <EmptyState headingLevel={2} icon="file-text" title="No delegated work yet" description="Tasks delegated from your chats will appear here, including their saved reports." />}
      {m.listLoading && <p className="carrier-history-note" role="status">Refreshing delegated work…</p>}
    </div>
    <div className="carrier-delegated-pagination">
      <Button variant="ghost" size="sm" disabled={!m.hasPrevious || m.listLoading} onPress={m.previous}>Newer tasks</Button>
      <Button variant="ghost" size="sm" disabled={m.page.next_before === null || m.listLoading} onPress={m.next}>Older tasks</Button>
    </div>
  </>
}

export function CarrierDelegatedReader({ model: m }: { model: DelegatedWorkModel }) {
  const task = m.detail
  return <div className="carrier-reader-scroll carrier-delegated-detail">
    {m.detailError && <div className="carrier-error" role="alert"><span>Task details could not be refreshed. {m.detailError}</span><Button variant="ghost" size="sm" onPress={m.retryDetail}>Retry task details</Button></div>}
    {m.detailLoading && !task && <p role="status">Loading task details…</p>}
    {task ? <>
      <div className="carrier-subject"><h2 tabIndex={-1}>{task.title || task.taskId}</h2><Badge>{task.status}</Badge></div>
      <dl className="carrier-delegated-facts">
        <dt>Provider</dt><dd>{task.provider}</dd><dt>Mode</dt><dd>{task.mode}</dd>
        <dt>Task status</dt><dd>{task.status}</dd>
        <dt>Recorded execution outcome</dt><dd>{task.executionOutcome ?? 'Not recorded'}</dd>
        <dt>Report acceptance</dt><dd>{task.reportAccepted ? 'Accepted' : 'Not accepted'}</dd>
        <dt>Task</dt><dd>{task.taskId}</dd><dt>Attempt</dt><dd>{task.attemptId ?? 'Not recorded'}</dd>
        <dt>Execution</dt><dd>{task.executionId ?? 'Not recorded'}</dd><dt>Turn</dt><dd>{task.turnId ?? 'Not recorded'}</dd>
      </dl>
      <div className="carrier-context-links"><ChatLink chat={task.parentChat} label="Parent chat" />{task.childChat && <ChatLink chat={task.childChat} label="Child chat" />}</div>
      {task.error && <p className="carrier-error" role="alert">{task.error}</p>}
      <section aria-label="Task report"><h3>Report</h3>
        {task.report ? <><p>Report outcome: {task.report.outcome}</p><pre className="carrier-delegated-report">{task.report.body}</pre>
          <h4>Artifacts</h4>{task.report.artifacts.length ? <ul>{task.report.artifacts.map((artifact, index) => <li key={index}>
            {artifact.description && <p>{artifact.description}</p>}<code>{artifact.uri}</code>{artifact.sha256 && <p>SHA256: <code>{artifact.sha256}</code></p>}
          </li>)}</ul> : <p>No artifacts reported.</p>}</> : <p>No report recorded.</p>}
      </section>
      <section aria-label="Carrier receipt"><h3>Carrier receipt</h3>{task.receipt ? <><p>Message: {task.receipt.messageId}</p><p>{task.receipt.acknowledged ? 'Acknowledged' : 'Not acknowledged'}</p></> : <p>No receipt recorded.</p>}</section>
    </> : !m.selected ? <EmptyState headingLevel={2} icon="file-text" title="Select delegated work" description="Review a task’s recorded status, report, artifacts, and Carrier receipt." /> : null}
  </div>
}
