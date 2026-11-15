import type { Workspace } from '../workspace/model'

/** A workflow handoff starts in the main inbox with its exact delivered report. */
export function openMainInbox(workspace: Workspace, navigate: (route: string) => void, messageId?: number) {
  workspace.carrier.setMailbox('user')
  workspace.carrier.setView('Inbox')
  workspace.carrier.setSearch('')
  workspace.carrier.setOffset(0)
  workspace.setActiveMessage(messageId == null ? '' : String(messageId))
  navigate('carrier')
}
