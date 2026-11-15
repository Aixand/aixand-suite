import type { Session } from './connection'
import { sessionKind } from './context'

export type SessionAction = {
  id: string
  label: string
  op: 'stop' | 'restart' | 'remove'
  force?: boolean
  description: string
  disabled: boolean
}

export function sessionActions(session: Session, savedShell = false): SessionAction[] {
  const state = session.lifecycle.state
  const terminal = ['stopped', 'exited', 'failed'].includes(state)
  const scheduled = session.restart_status?.state === 'scheduled'
  const actions: SessionAction[] = [
    {
      id: 'force-stop',
      label: 'Force stop',
      op: 'stop',
      force: true,
      description: 'Terminate the shell and its processes immediately.',
      disabled: !['running', 'starting', 'stopping'].includes(state)
    },
    {
      id: 'restart',
      label: 'Restart',
      op: 'restart',
      force: false,
      description: 'Stop gracefully, then start a new process using the saved configuration.',
      disabled: state !== 'running' && !terminal
    },
    {
      id: 'force-restart',
      label: 'Force restart',
      op: 'restart',
      force: true,
      description: 'Terminate immediately, then start a new process using the saved configuration.',
      disabled: state !== 'running' && !terminal
    },
    {
      id: scheduled ? 'cancel-restart' : 'stop',
      label: scheduled ? 'Cancel scheduled restart' : 'Stop gracefully',
      op: 'stop',
      force: false,
      description: scheduled
        ? 'Cancel the pending automatic restart.'
        : 'Send the configured stop signal, then terminate if the stop timeout expires.',
      disabled: !['running', 'starting'].includes(state) && !scheduled
    },
    {
      id: 'remove',
      label: 'Remove',
      op: 'remove',
      description: `Permanently remove this finished session and its retained output.${savedShell ? ' The saved group shell remains available to restore.' : ''}`,
      disabled: !terminal || scheduled
    }
  ]
  const sharedCodexServer =
    sessionKind(session.labels) === 'server' &&
    (session.labels?.['service.name'] === 'codex-app-server' ||
      session.labels?.feature === 'app-server')
  if (sharedCodexServer) {
    for (const action of actions) {
      if (action.op === 'restart' || (action.op === 'stop' && !scheduled))
        action.description += ' All conversations using this Codex server are affected.'
    }
  }
  return actions
}
