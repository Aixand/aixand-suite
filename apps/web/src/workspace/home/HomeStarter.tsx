import { Button, Icon } from 'bbb-design'
import type { Workspace } from '../model'
import { HomeChatComposer } from '../ChatPage'
import type { SavedWorkflow } from '../../workflows/library'

export function HomeStarter({ workspace: w, navigate, onWorkflow, onTerminal, onProjects, onInbox, inboxCount, workflows }: {
  workspace: Workspace; workflows: SavedWorkflow[]; navigate: (route: string) => void
  onWorkflow: () => void; onTerminal: () => void; onProjects: () => void; onInbox: () => void; inboxCount: number
}) {
  return <>
    <section className="home-launch" aria-labelledby="home-launch-heading">
      <div className="home-launch-heading">
        <h2 id="home-launch-heading">What would you like to work on?</h2>
      </div>
      <HomeChatComposer workspace={w} navigate={navigate} workflows={workflows} />
    </section>
    <section className="home-quick-actions" aria-labelledby="home-quick-actions-heading">
      <h2 id="home-quick-actions-heading">Quick actions</h2>
      <div className="home-shortcuts" role="group" aria-label="Quick actions">
        <Button variant="secondary" onPress={onWorkflow}><Icon name="workflow" /><span className="home-shortcut-label">Run workflow</span></Button>
        <Button variant="secondary" onPress={onTerminal}><Icon name="square-terminal" /><span className="home-shortcut-label">Open terminal</span></Button>
        <Button variant="secondary" onPress={onProjects}><Icon name="folder" /><span className="home-shortcut-label">Browse projects</span></Button>
        <Button variant="secondary" onPress={onInbox}><Icon name="mail" /><span className="home-shortcut-label">Inbox</span>{inboxCount > 0 && <span className="home-shortcut-count">{inboxCount}</span>}</Button>
      </div>
    </section>
  </>
}
