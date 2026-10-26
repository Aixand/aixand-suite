import { useState } from 'react'
import { Icon } from 'bbb-design'
import { CopyButton } from './MessageContent'
import { ScrollRegion } from '../components/ScrollRegion'
import type { ChatItem } from './model'

export type TranscriptEntry = { kind: 'message'; item: ChatItem } | { kind: 'activity'; items: ChatItem[] }

export function transcriptEntries(items: ChatItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const item of items) {
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      entries.push({ kind: 'message', item })
    } else {
      const previous = entries.at(-1)
      if (previous?.kind === 'activity') previous.items.push(item)
      else entries.push({ kind: 'activity', items: [item] })
    }
  }
  return entries
}

function activityInfo(item: ChatItem): { label: string; preview?: string } {
  if (item.type === 'commandExecution') return { label: 'Ran a command', preview: item.command ?? undefined }
  if (item.type === 'fileChange') return { label: 'File changes', preview: item.text.split('\n')[0] }
  if (item.type === 'reasoning') return { label: 'Thinking' }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { label: 'Used a tool', preview: item.text.split('\n')[0] }
  if (item.type === 'webSearch') return { label: 'Searched the web', preview: item.text.split('\n')[0] }
  if (item.type === 'plan') return { label: 'Updated the plan' }
  return { label: 'Agent activity' }
}

function activityStatus(item: ChatItem, active: boolean) {
  if (item.exitCode != null && item.exitCode !== 0) return { label: `Exit ${item.exitCode}`, tone: 'error' }
  if (['failed', 'error', 'declined'].includes(item.status ?? '')) return { label: 'Failed', tone: 'error' }
  if (['inProgress', 'running', 'started'].includes(item.status ?? '')) return { label: active ? 'Running' : 'Stopped', tone: active ? 'active' : 'muted' }
  if (item.status === 'interrupted') return { label: 'Stopped', tone: 'muted' }
  if (!item.status && active) return { label: 'Working', tone: 'active' }
  if (item.status && !['completed', 'done'].includes(item.status)) return { label: item.status.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' '), tone: 'muted' }
  return { label: 'Done', tone: 'complete' }
}

export function ActivityGroup({ items, active }: { items: ChatItem[]; active: boolean }) {
  const [open, setOpen] = useState(false)
  const tools = items.filter((item) => item.type !== 'reasoning').length
  const failed = items.some((item) => activityStatus(item, active).tone === 'error')
  const label = tools ? `${tools} ${tools === 1 ? 'tool used' : 'tools used'}` : 'Thinking'
  return <details className="command-activity-group" onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}>
    <summary className="command-activity-summary">
      <Icon name="chevron-right" className="command-disclosure-chevron" />
      <span className="command-activity-heading">
        <span>Agent activity</span>
        <span className="command-activity-count">{active ? `Working · ${label}` : label}</span>
        {failed && <span className="command-activity-error">Needs attention</span>}
      </span>
    </summary>
    {open && <div className="command-activity-list">
      {items.map((item) => {
        const info = activityInfo(item)
        const status = activityStatus(item, active)
        return <ToolActivity key={item.id} item={item} info={info} status={status} />
      })}
    </div>}
  </details>
}

function ToolActivity({ item, info, status }: { item: ChatItem; info: ReturnType<typeof activityInfo>; status: ReturnType<typeof activityStatus> }) {
  const [open, setOpen] = useState(false)
  return <details className="command-tool-activity" onToggle={(event) => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}>
          <summary>
            <Icon name="chevron-right" className="command-disclosure-chevron" />
            <span className="command-tool-description"><span>{info.label}</span>{info.preview && <code title={info.preview}>{info.preview}</code>}</span>
            <span className="command-tool-status" data-tone={status.tone}>{status.label}</span>
          </summary>
          {open && <div className="command-tool-content">
            {item.command && <div className="command-tool-command"><span>Command</span><code>{item.command}</code></div>}
            {item.text ? <><div className="command-tool-output-heading"><span>{item.type === 'reasoning' ? 'Summary' : item.type === 'fileChange' ? 'Changes' : 'Output'}</span><CopyButton text={item.text} label="Copy activity output" showLabel /></div><ScrollRegion as="pre" label="Activity output">{item.text}</ScrollRegion></> : <p>{status.tone === 'active' ? 'Waiting for output…' : 'No output recorded.'}</p>}
          </div>}
        </details>
}
