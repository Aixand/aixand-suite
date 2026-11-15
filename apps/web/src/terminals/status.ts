import type { Session } from './connection'

type Status = { state: string; label: string }

export function terminalStatus(session?: Session | null): Status {
  if (!session) return { state: 'unavailable', label: 'Unavailable' }
  const { state, code } = session.lifecycle
  if (state === 'failed' || state === 'exited' && code != null && code !== 0)
    return { state: 'failed', label: 'Failed' }
  if (state !== 'running') return { state, label: state[0]?.toUpperCase() + state.slice(1) }

  const { execution, interaction, constraint } = session.foreground ?? {}
  // Undercurrent selects each foreground axis independently. Inferred execution
  // is usable; only an affirmative request means the session needs user input.
  const observed = (observation: typeof execution) =>
    observation?.basis?.disposition === 'affirmative' || observation?.basis?.disposition === 'inference'
  const confirmed = (observation: typeof execution) => observation?.basis?.disposition === 'affirmative'
  const describe = (label: string, observation: typeof execution) =>
    label + (observation?.basis?.disposition === 'inference' ? ' (inferred)' : '')
  const active = observed(execution) && execution.state === 'active'
  const idle = observed(execution) && execution.state === 'quiescent'
  const requested = confirmed(interaction) && interaction.state === 'requested'
  const available = observed(interaction) && interaction.state === 'available'
  const constrained = observed(constraint) && constraint.state === 'present'
  const input = requested
    ? interaction.modality === 'secret' ? 'waiting for private input'
      : /confirm|approv|permission|trust/i.test(interaction.semantic ?? '') ? 'waiting for confirmation'
      : interaction.modality === 'options' ? 'waiting for a choice' : 'waiting for input'
    : available ? describe(interaction.modality === 'secret' ? 'private input available' : 'input available', interaction) : undefined
  const label = ['Running', active ? describe('active', execution) : idle ? describe('idle', execution) : 'activity unknown',
    input, constrained && describe('runtime constraint present', constraint)].filter(Boolean).join(' · ')

  // Running establishes liveness even when no foreground evidence is available.
  // Available input is not a request; a constraint does not prove execution stopped.
  return { state: requested ? 'waiting' : constrained ? 'constrained' : active ? 'active'
    : available ? 'ready' : idle ? 'idle' : 'running', label }
}
