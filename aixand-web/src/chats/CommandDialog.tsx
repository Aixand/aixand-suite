import { useState } from 'react'
import { Button, Dialog } from 'bbb-design'
import { CopyButton } from './MessageContent'
import type { ChatCommand, CommandOutput } from './commands'

export type CommandPanel = { kind: 'help'; commands: ChatCommand[] } |
  { kind: 'text'; title: string; output: CommandOutput } |
  { kind: 'history'; title: string; chats: { id: string; title: string }[] } |
  { kind: 'terminal'; command: ChatCommand; text: string; canOpen: boolean } |
  { kind: 'input'; command: ChatCommand; label: string }

export function CommandDialog({ panel, onClose, onCommand, onChat, onTerminal, onArguments, onInsert }: {
  panel: CommandPanel | null; onClose: () => void; onCommand: (command: ChatCommand) => void
  onChat: (id: string) => void; onTerminal: () => void; onArguments: (command: ChatCommand, value: string) => void
  onInsert: (text: string) => void
}) {
  const [argument, setArgument] = useState('')
  const title = !panel ? 'Commands' : panel.kind === 'help' ? 'Available commands' :
    panel.kind === 'terminal' ? `/${panel.command.name} · Terminal` : panel.kind === 'input' ? `/${panel.command.name}` : panel.title
  function download(output: CommandOutput) {
    const url = URL.createObjectURL(new Blob([output.text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = output.filename || 'conversation.md'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  let skills: { name: string; enabled?: boolean }[] = []
  if (panel?.kind === 'text' && panel.output.resource === 'skills') {
    try {
      const groups = JSON.parse(panel.output.text) as { skills?: { name: string; enabled?: boolean }[] }[]
      skills = groups.flatMap(group => group.skills ?? []).filter(skill => typeof skill.name === 'string' && /^[\w.-]+$/.test(skill.name) && skill.enabled !== false)
    } catch { /* The raw provider result remains available below. */ }
  }
  return <Dialog trigger={<Button style={{ display: 'none' }}>Command details</Button>} title={title}
    open={Boolean(panel)} onOpenChange={open => { if (!open) onClose() }}>
    <div className="chat-command-dialog">
      {panel?.kind === 'help' && panel.commands.map(command => <div key={command.name} className="chat-command-help-row">
        <Button variant="ghost" disabled={command.execution === 'unsupported'} onPress={() => onCommand(command)}>/{command.name}</Button>
        <span>{command.description}<small>{command.execution === 'terminal' ? 'Opens the same conversation in Terminal' : command.execution === 'unsupported' ? command.reason : command.execution === 'client' || command.execution === 'suite' ? 'Web interaction' : 'Provider session'}</small></span>
      </div>)}
      {panel?.kind === 'text' && <>
        {skills.length > 0 && <div role="group" aria-label="Available native skills">{skills.map(skill =>
          <Button key={skill.name} variant="ghost" onPress={() => onInsert('/skills ' + skill.name + ' ')}>Use {skill.name}</Button>)}</div>}
        <div className="command-answer-options"><CopyButton text={panel.output.text} label="Copy command output" showLabel />
          {panel.output.format === 'markdown' && <Button variant="ghost" onPress={() => download(panel.output)}>Download Markdown</Button>}</div>
        {panel.output.truncated && <p>Output exceeds the display limit. This is a preview.</p>}
        <pre className="chat-command-output">{panel.output.text}</pre>
      </>}
      {panel?.kind === 'history' && (panel.chats.length ? panel.chats.map(chat =>
        <Button key={chat.id} variant="ghost" onPress={() => onChat(chat.id)}>{chat.title}</Button>) : <p>No matching conversations.</p>)}
      {panel?.kind === 'terminal' && <>
        <p>{panel.command.reason}</p><pre>{panel.text}</pre>
        <p>The chat will hand input to the existing provider session. Enter this command in the terminal.</p>
        <CopyButton text={panel.text} label="Copy terminal command" showLabel />
        {panel.canOpen && <Button onPress={onTerminal}>Continue in Terminal</Button>}
      </>}
      {panel?.kind === 'input' && <form onSubmit={event => { event.preventDefault(); if (argument.trim()) onArguments(panel.command, argument.trim()) }}>
        <label>{panel.label}<input className="command-queue-input" value={argument} maxLength={24000} onChange={event => setArgument(event.target.value)} autoFocus /></label>
        <Button type="submit" disabled={!argument.trim()}>Run /{panel.command.name}</Button>
      </form>}
    </div>
  </Dialog>
}
