import type { ReactNode } from 'react'
import type { McpDefinition } from './McpDefinitionEditor'
import '../resources/dialog.css'

export function McpServerOverview({ definition, children }: { definition: McpDefinition; children?: ReactNode }) {
  return <div className="mcp-server-overview">
    <section className="mcp-launch-summary" aria-label="Launch configuration"><h3>Launch command</h3>
      <code className="mcp-launch-command">{definition.command || 'No command configured'}{definition.args?.map((argument, index) => <span key={index}> {(/\s|["']/.test(argument) || !argument) ? JSON.stringify(argument) : argument}</span>)}</code>
      <h3>Working directory</h3><p>{definition.cwd || 'Uses the session directory'}</p>
    </section>
    {children}
    <details className="resource-detail-disclosure"><summary>Environment variables ({definition.env_vars?.length ?? 0})</summary>
      {definition.env_vars?.length ? <ul className="mcp-environment-names">{definition.env_vars.map(name => <li key={name}><code>{name}</code></li>)}</ul> : <p className="carrier-muted">No environment variables referenced.</p>}
    </details>
    <details className="resource-detail-disclosure"><summary>Advanced configuration</summary><dl className="agent-source-details">
      <dt>Server type</dt><dd>{definition.kind === 'sonar' || definition.kind === 'lore' ? 'Project indexing' : 'Local command'}</dd>
      <dt>Startup timeout</dt><dd>{definition.startup_timeout_sec ?? 60} seconds</dd><dt>Tool timeout</dt><dd>{definition.tool_timeout_sec ?? 60} seconds</dd>
    </dl></details>
  </div>
}
