import { useState } from 'react'
import { Badge, Button } from 'bbb-design'
import { fileSize, type ProjectRun } from './model'
import './connect.css'
import { ProjectProfile } from './ProjectProfile'

const terminal = (run: ProjectRun) => ['completed', 'failed', 'cancelled'].includes(run.status)
const labels: Record<string, string> = { queued: 'Queued', preparing: 'Preparing', sending: 'Sending project', staging: 'Preparing folder',
  starting: 'Starting tests', running: 'Testing', waiting: 'Needs your response', uncertain: 'Unconfirmed', failed: 'Could not finish', cancelled: 'Stopped', completed: 'Review result' }
const outcomes: Record<string, string> = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', unconfirmed: 'Review result' }

export function ProjectComparisonCard({ run, connected, onAction, onOpen }: {
  run: ProjectRun; connected: boolean
  onAction?: (id: string, action: 'cancel' | 'check', targetId?: string) => Promise<unknown>
  onOpen?: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const targets = run.targets ?? []
  const finished = targets.filter(terminal).length
  const passed = targets.filter((target) => target.report?.outcome === 'passed').length
  const state = run.status === 'preparing' ? 'Preparing shared snapshot' : run.status === 'completed' ? 'Results ready'
    : run.status === 'failed' ? 'Comparison failed' : run.status === 'cancelled' ? 'Stopped' : 'Comparing machines'
  async function act(action: 'cancel' | 'check', targetId?: string) {
    setBusy(true); setError('')
    try { await onAction?.(run.id, action, targetId) } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <article className="connect-transfer connect-comparison" aria-label={`Project comparison: ${run.project}`}>
    <div className="connect-row"><strong>{run.project} across {targets.length} machines</strong><Badge>{state}</Badge></div>
    <p>{finished} of {targets.length} finished · {passed} passed</p>
    {run.snapshotId && <details><summary>Shared source snapshot</summary>
      <p>{run.fileCount} source files · {fileSize(run.sourceBytes ?? 0)}</p>
      <p className="connect-path">Source identity: <code>{run.snapshotId}</code></p>
      <p>Each machine starts from these same files in its own workspace. Installed dependencies, build output, and common credential files are excluded.</p>
    </details>}
    <div className="connect-comparison-targets">{targets.map((target) => <section className="connect-device" aria-label={`Test on ${target.device}`} key={target.id}>
      <div className="connect-row"><strong>{target.device}</strong><Badge>{target.report ? outcomes[target.report.outcome] : labels[target.status] ?? target.status}</Badge></div>
      <ProjectProfile run={target} />
      {target.status === 'sending' && <progress aria-label={`Project transfer to ${target.device}`} max={Math.max(1, target.size)} value={target.bytesSent} />}
      {target.cwd && <details><summary>Workspace and test details</summary><p className="connect-path"><code>{target.cwd}</code></p>
        {!!target.report?.checks.length && <ul>{target.report.checks.map((check, index) => <li className="connect-path" key={index}>
          <code>{check.command}</code> · {check.exitCode === null ? 'Not run' : `Exit ${check.exitCode}`}</li>)}</ul>}
      </details>}
      {target.report && <p>{target.report.summary}</p>}
      {target.error && <p>{target.error}</p>}
      {target.status === 'waiting' && <p>Open this machine’s chat to answer its question or approve a command.</p>}
      <div className="connect-row">
        {onOpen && target.cwd && target.childChatId && !target.childConversationDeleted && <Button variant="secondary" size="sm" onPress={() => onOpen(target.childChatId!)}>{target.status === 'waiting' ? 'Open chat to respond' : 'Open test chat'}</Button>}
        {onAction && target.status === 'uncertain' && <Button variant="secondary" size="sm" disabled={!connected || busy} onPress={() => { void act('check', target.id) }}>Check machine</Button>}
        {onAction && !terminal(target) && <Button variant="ghost" size="sm" disabled={!connected || busy || target.cancelRequested} onPress={() => { void act('cancel', target.id) }}>{target.cancelRequested ? 'Stopping…' : 'Stop machine'}</Button>}
      </div>
    </section>)}</div>
    <p className="settings-help">Results are reported by Codex on each machine. The linked chats contain command output and execution details.</p>
    {run.error && <p>{run.error}</p>}
    {!connected && !terminal(run) && <p role="status">Reconnect to refresh the comparison.</p>}
    <div className="connect-row">
      {onAction && targets.some((target) => target.status === 'uncertain') && <Button variant="secondary" size="sm" disabled={!connected || busy} onPress={() => { void act('check') }}>Check all machines</Button>}
      {onAction && !terminal(run) && <Button variant="ghost" size="sm" disabled={!connected || busy || run.cancelRequested} onPress={() => { void act('cancel') }}>{run.cancelRequested ? 'Stopping…' : 'Stop all machines'}</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </article>
}
