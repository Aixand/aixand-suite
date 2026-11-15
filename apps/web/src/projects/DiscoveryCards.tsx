import { Button } from 'bbb-design'
import { discoveryActive, discoveryFilterActive, discoveryFilterSummary, discoverySummary, type Discovery } from './model'

const labels: Record<Discovery['state'], string> = {
  queued: 'Queued', scanning: 'Discovering projects…', registering: 'Adding projects…', completed: 'Completed',
  partial: 'Completed with gaps', cancelled: 'Stopped', interrupted: 'Interrupted', failed: 'Could not finish',
}
export function DiscoveryCards({ jobs, connected, onView }: {
  jobs: Discovery[]; connected: boolean; onView: (jobId: string) => void
}) {
  if (!jobs.length) return null
  return <section className="command-launches" aria-label="Project discoveries">
    {jobs.map((job) => <article className="command-launch-card" key={job.id} aria-label={`Discovery under ${job.root}`}>
      <strong>Project discovery</strong>
      <p className="command-launch-context project-discovery-path">{job.root}</p>
      <p role="status">{labels[job.state]}{!connected && discoveryActive(job) ? ' · Reconnect to refresh' : ''}</p>
      <p>{discoverySummary(job)}</p>
      {discoveryFilterActive(job) && <>
        <p>{discoveryFilterSummary(job)}</p>
        {!!job.filtered?.preview.length && <ul className="project-discovery-preview" aria-label="Matching projects">
          {job.filtered.preview.map((row) => <li key={row.id}><strong>{row.suggestedName}</strong>
            <small className="project-discovery-path">{row.path}</small></li>)}
        </ul>}
        {job.filtered && job.filtered.matched > job.filtered.preview.length && <p>View discovery to see all matching projects.</p>}
      </>}
      {!job.scanComplete && !discoveryActive(job) && <p>Some locations could not be fully inspected. Review the coverage details.</p>}
      {job.error && <p className="command-launch-error">{job.error}</p>}
      <Button variant="ghost" size="sm" onPress={() => onView(job.id)}>View discovery</Button>
    </article>)}
  </section>
}
