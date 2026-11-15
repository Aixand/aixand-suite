import { useState } from 'react'
import { Badge, Button } from 'bbb-design'
import { fileSize, type ProjectRun } from './model'
import { ProjectComparisonCard } from './ProjectComparisonCard'
import './connect.css'
import { ProjectProfile } from './ProjectProfile'

const labels: Record<string, string> = { preparing: 'Preparing snapshot', sending: 'Sending project', staging: 'Preparing remote folder',
  starting: 'Starting tests', running: 'Testing', waiting: 'Needs your response', uncertain: 'Check run status', failed: 'Run failed', cancelled: 'Stopped', completed: 'Tests finished' }
const outcomes: Record<string, string> = { passed: 'Tests passed', failed: 'Tests failed', blocked: 'Tests blocked', unconfirmed: 'Review test result' }

export function ProjectRunCard({ run, connected, onAction, onOpen }: {
  run: ProjectRun; connected: boolean
  onAction?: (id: string, action: 'cancel' | 'check', targetId?: string) => Promise<unknown>
  onOpen?: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const copy = run.purpose === 'copy'
  const label = copy && run.status === 'completed' ? 'Project ready' : run.report ? outcomes[run.report.outcome] : labels[run.status] ?? run.status
  const active = !['completed', 'failed', 'cancelled'].includes(run.status)
  async function act(action: 'cancel' | 'check') {
    setBusy(true); setError('')
    try { await onAction?.(run.id, action) } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  if (run.purpose === 'matrix') return <ProjectComparisonCard run={run} connected={connected} onAction={onAction} onOpen={onOpen} />
  return <article className="connect-transfer connect-project-run" aria-label={`Project ${copy ? 'copy' : 'test'}: ${run.project} on ${run.device}`}>
    <div className="connect-row"><strong>{run.project} → {run.device}</strong><Badge>{label}</Badge></div>
    {!copy && <ProjectProfile run={run} />}
    {run.status === 'sending' && <><progress aria-label={`Project transfer progress for ${run.project}`} max={Math.max(1, run.size)} value={run.bytesSent} />
      <p>{fileSize(run.bytesSent)} / {fileSize(run.size)}</p></>}
    {run.fileCount != null && <p>{run.fileCount} source files · {fileSize(run.sourceBytes ?? 0)}</p>}
    {run.cwd && <p className="connect-path">{copy ? 'Project folder' : 'Remote workspace'}: <code>{run.cwd}</code></p>}
    {copy && run.status === 'completed' && <p>Files copied and extracted on {run.device}. You can now ask this chat to work in that folder.</p>}
    {run.status === 'waiting' && <p>Open the remote chat to answer Codex or approve a command.</p>}
    {run.report && <div><p>{run.report.summary}</p><p className="settings-help">Test report from Codex on {run.device}. Execution details are in the remote chat.</p>
      {!!run.report.checks.length && <ul>{run.report.checks.map((check, i) => <li className="connect-path" key={i}><code>{check.command}</code> · {check.exitCode === null ? 'Not run' : `Exit ${check.exitCode}`}</li>)}</ul>}
    </div>}
    {run.snapshotId && <details><summary>Snapshot details</summary><p className="connect-path">Source identity: <code>{run.snapshotId}</code></p>
      <p>Includes current working files. Dependency folders, build output, common credentials{run.gitIgnored ? ', and Git-ignored untracked files' : ''} are excluded.</p>
      {!!run.excludedCount && <p>{run.excludedCount} additional paths excluded.</p>}</details>}
    {run.error && <p>{run.error}</p>}
    {!connected && active && <p role="status">Reconnect to refresh this run’s progress.</p>}
    <div className="connect-row">
      {onOpen && run.cwd && run.childChatId && !run.childConversationDeleted && <Button variant="secondary" size="sm" onPress={() => onOpen(run.childChatId!)}>{run.status === 'waiting' ? 'Open chat to respond' : 'Open remote chat'}</Button>}
      {onAction && run.status === 'uncertain' && <Button variant="secondary" size="sm" disabled={!connected || busy} onPress={() => { void act('check') }}>{copy ? 'Check project copy' : 'Check project run'}</Button>}
      {onAction && active && <Button variant="ghost" size="sm" disabled={!connected || busy || run.cancelRequested} onPress={() => { void act('cancel') }}>{run.cancelRequested ? 'Stopping…' : copy ? 'Stop project copy' : 'Stop project run'}</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </article>
}
