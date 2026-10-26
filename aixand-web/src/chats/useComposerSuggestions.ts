import { useEffect, useRef, useState } from 'react'
import type { IconName } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { ProjectDirectory } from '../projects/files'
import type { ChatCommand, CommandsState } from './commands'
import { activeFileMention, fileLocation, fileQuery, fileToken, retainedFileReferences, type FileReference } from './fileReferences'
import type { Mailbox } from '../carrier/client'

export type ComposerContext = {
  agents: AgentsModel; project?: { id: string; name: string }; scope: string
  commands: ChatCommand[]; commandsState?: CommandsState; commandsError?: string
  onCommandsOpen: () => void; onChooseCommand: (command: ChatCommand) => void
  mailboxes?: Mailbox[]
}
export type SuggestionOption = { key: string; label: string; detail: string; icon?: IconName; choose: () => void }

export function useComposerSuggestions(context: ComposerContext | undefined, value: string, caret: number, enabled: boolean,
  files: FileReference[], change: (value: string, files: FileReference[], caret: number) => void) {
  const live = useRef(context); live.current = context
  const file = enabled && context ? activeFileMention(value, caret) : null
  const before = caret >= 0 ? value.slice(0, caret).trimStart() : ''
  const slash = enabled && !!context && before.startsWith('/') && !before.includes('\n')
  const query = before.slice(1)
  const matching = slash ? context!.commands.filter(row => row.name.toLowerCase().startsWith(query.toLowerCase())) : []
  const command = slash && (!/[\s/]/.test(query) || matching.length > 0)
  const path = file ? fileQuery(file.token) : ''
  const { directory, search, error: pathError } = fileLocation(path)
  const [listing, setListing] = useState<ProjectDirectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(0)
  const projectId = context?.project?.id
  useEffect(() => { setOffset(0); setListing(null) }, [projectId, directory])
  useEffect(() => {
    if (!file || !projectId || pathError) { setLoading(false); return }
    let alive = true
    setLoading(true); setError('')
    void live.current!.agents.request<ProjectDirectory>('project-files-list', { projectId, path: directory, offset, limit: 200 })
      .then(result => { if (alive) setListing(previous => offset && previous && previous.projectId === projectId && previous.path === directory ?
        { ...result, entries: [...previous.entries, ...result.entries] } : result) })
      .catch((cause: Error) => { if (alive) setError(cause.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [Boolean(file), projectId, directory, offset, pathError, context?.agents.status])
  let options: SuggestionOption[] = []
  if (file) {
    options = (!pathError && listing?.projectId === projectId && listing?.path === directory ? listing.entries : [])
      .filter(row => row.supported && row.name.toLowerCase().includes(search)).map(row => ({ key: row.path,
        label: row.name + (row.kind === 'directory' ? '/' : ''), detail: row.path, icon: row.kind === 'directory' ? 'folder' : 'file-text',
        choose: () => {
          const token = fileToken(row.path + (row.kind === 'directory' ? '/' : ''))
          const suffix = row.kind === 'directory' ? '' : ' '
          const updated = value.slice(0, file.start) + token + suffix + value.slice(file.end)
          if (updated.length > 32000) { setError('The message is full. Shorten it before adding a reference.'); return }
          const kept = retainedFileReferences(updated, files).filter(item => item.token !== token)
          change(updated, row.kind === 'directory' ? kept : [...kept, { token, projectId: projectId!, path: row.path }], file.start + token.length + suffix.length)
        } }))
    if (listing?.nextOffset != null) options.push({ key: 'more-files', label: 'More files', detail: 'Load the next page', icon: 'folder', choose: () => setOffset(listing.nextOffset!) })
  } else if (command) {
    options = matching.map(row => ({ key: row.name, label: '/' + row.name, detail: row.description +
      (row.execution === 'terminal' ? ' · Opens terminal' : row.execution === 'unsupported' ? ` · Unavailable: ${row.reason ?? 'Provider support required'}` : row.inputHint ? ` · ${row.inputHint}` : ''), icon: 'wrench',
      choose: () => {
        if (['setting', 'client', 'terminal', 'unsupported'].includes(row.execution)) context!.onChooseCommand(row)
        else { const updated = '/' + row.name + ' '; change(updated, [], updated.length) }
      } }))
  }
  const status = file ? !projectId ? 'Choose a project to reference its files.' : pathError || error : context?.commandsError ?? ''
  return { active: Boolean(file || command), commandMode: Boolean(command), exactCommand: command && matching.some(row => '/' + row.name === value.trim()),
    signature: file ? `file:${projectId}:${file.start}:${file.token}` : `commands:${context?.scope}:${query}`,
    heading: file ? `Choose a file${context?.project ? ` · ${context.project.name}` : ''}` : 'Commands', options,
    loading: file ? loading : context?.commandsState === 'loading' && matching.length === 0, error: status,
    empty: file ? 'No files match this path.' : context?.commandsState === 'unsupported' ? 'This backend does not expose commands.' : 'No commands match.',
    loadingText: file ? 'Loading project files…' : 'Refreshing available commands…' }
}
