import type { ChatCommand } from './commands'

// Native shortcuts remain available without starting an SDK session.
// Provider command references:
// https://code.claude.com/docs/en/commands
// https://www.antigravity.google/docs/cli/reference/
export function nativeComposerCommands(provider: string): ChatCommand[] | undefined {
  if (!['claude', 'antigravity'].includes(provider)) return undefined
  const terminal = (name: string, description: string): ChatCommand => ({ name, description, execution: 'terminal',
    reason: 'This command runs inside the provider’s interactive terminal.' })
  return [
    { name: 'model', description: 'Choose a model for your next terminal session', execution: 'client', action: 'model', inputHint: '[model ID]' },
    { name: 'help', description: 'Browse available commands', execution: 'client', action: 'help' },
    { name: 'new', description: 'Start a fresh draft', execution: 'client', action: 'new' },
    { name: 'settings', description: 'Open chat and terminal launch settings', execution: 'client', action: 'settings' },
    terminal('permissions', 'Manage tool permissions'),
    terminal('plan', 'Plan a task'),
    terminal('effort', 'Choose reasoning effort'),
    terminal('context', 'Inspect context usage'),
    terminal('mcp', 'Manage MCP connections'),
    terminal('config', 'Configure provider settings'),
    terminal('resume', 'Resume a provider conversation'),
    terminal('usage', 'Inspect account usage'),
    ...(provider === 'claude' ? [terminal('status', 'Inspect the active account and session'),
      terminal('compact', 'Compact conversation context')] : [terminal('plugin', 'Manage provider plugins'),
      terminal('skills', 'Browse provider skills')]),
  ]
}
