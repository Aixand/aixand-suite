import { SettingsSection } from 'bbb-design'
import type { AgentsModel } from '../agents/model'

export function ResetSettings(_props: { agents: AgentsModel }) {
  return <SettingsSection className="settings-group settings-reset" title="Reset data" headingLevel={2}
    description="Workspace reset from Settings is unavailable in this alpha.">
    <p>For a local Desktop installation, open the Aixand launcher → This computer → Advanced → Reset or remove components.</p>
    <p>For a Server installation, run <code>aixand-server reset</code> on the server to review cleanup options.</p>
  </SettingsSection>
}
