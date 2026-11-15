import { Progress } from 'bbb-design'
import type { AgentJob } from './client'
import './installation-progress.css'

function bytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function InstallationProgress({ job, connected = true }: { job: AgentJob; connected?: boolean }) {
  if (!['install', 'install-sdk', 'update', 'repair', 'uninstall'].includes(job.kind)) return null
  const progress = job.progress?.schema === 'agent-manager/install-progress-1' ? job.progress : undefined
  const active = connected && ['queued', 'starting', 'running'].includes(job.status)
  const succeeded = job.status === 'succeeded'
  const removal = job.kind === 'uninstall'
  const action = removal ? 'removal' : 'installation'
  const label = job.status === 'queued' ? 'Waiting for active agents to finish'
    : job.status === 'starting' ? `Starting ${action}`
      : progress?.stage === 'complete' && !succeeded ? `Finalizing ${action}`
        : progress?.label ?? (succeeded ? removal ? 'CLI removed' : 'Installation verified' : removal ? 'Removing CLI' : 'Installing')
  const transfer = progress?.stage === 'downloading' ? progress.transfer : undefined
  const measured = transfer?.total != null && transfer.total > 0 && transfer.completed >= 0 && transfer.completed <= transfer.total
  return <div className="installation-progress">
    {active || succeeded ? <Progress label={label} value={succeeded ? 1 : measured ? transfer!.completed : undefined}
      max={succeeded ? 1 : measured ? transfer!.total! : undefined} />
      : <p role="status">{!connected && ['queued', 'starting', 'running'].includes(job.status)
        ? `Reconnecting to ${action} progress…` : progress ? `Last reported stage: ${progress.label}` : `${removal ? 'Removal' : 'Installation'} progress is unavailable.`}</p>}
    {progress?.steps.total != null && <p className="installation-progress-detail" role="status">
      {progress.steps.completed} of {progress.steps.total} {action} steps complete
    </p>}
    {transfer && <p className="installation-progress-detail">{bytes(transfer.completed)}{measured ? ` of ${bytes(transfer.total!)}` : ''} downloaded</p>}
  </div>
}
