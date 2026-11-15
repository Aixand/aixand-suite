import type { SelectOption } from 'bbb-design'

export function messageTimingOptions(activeTurn: boolean, steerAvailable: boolean): SelectOption[] {
  return [
    ...(steerAvailable ? [{ id: 'steer', label: activeTurn ? 'Add to current turn' : 'Send now',
      description: activeTurn ? 'Give the agent more context while it works.' : 'Start a new turn with this message.' }] : []),
    { id: 'queue', label: 'Send after this turn', description: 'Keep this message in the queue for a later turn.' },
  ]
}
