import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { IconName, SelectOption } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { ProjectDirectory } from '../projects/files'
import { activeComposerCommand, type ChatCommand, type CommandsState } from './commands'
import { activeFileMention, fileLocation, fileQuery, fileToken, retainedFileReferences, type FileReference } from './fileReferences'
import type { Mailbox } from '../carrier/client'
import { mentionScore } from './composerMentions'

export type ComposerCommandSetting = {
  label: string; options: SelectOption[]; disabled: boolean; loading: boolean; error?: string
  onSelect: (id: string) => void; status?: ReactNode
}

export type ComposerContext = {
  agents: AgentsModel; project?: { id: string; name: string }; scope: string
  commands: ChatCommand[]; commandsState?: CommandsState; commandsError?: string
  onCommandsOpen: () => void; onChooseCommand: (command: ChatCommand, preserveDraft?: boolean) => void
  mailboxes?: Mailbox[]
  settings?: Record<string, ComposerCommandSetting>
}
export type SuggestionOption = { key: string; label: string; detail: string; icon?: IconName; choose: () => void }

export function useComposerSuggestions(context: ComposerContext | undefined, value: string, caret: number, enabled: boolean,
  files: FileReference[], change: (value: string, files: FileReference[], caret: number) => void) {
  const live = useRef(context); live.current = context
  const file = enabled && context ? activeFileMention(value, caret) : null
  const slash = enabled && context && !file ? activeComposerCommand(value, caret) : null
  const query = slash?.query ?? ''
  const argumentsQuery = /^([^\s/]+)[ \t]+(.*)$/.exec(query)
  const setting = slash && argumentsQuery ? context?.settings?.[argumentsQuery[1].toLowerCase()] : undefined
  const settingQuery = argumentsQuery?.[2] ?? ''
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
  function replaceCommand(text: string, position = text.length) {
    if (!slash) return
    const updated = value.slice(0, slash.start) + text + value.slice(slash.end)
    change(updated, retainedFileReferences(updated, files), slash.start + position)
  }
  function completeCommand(name: string) {
    const text = '/' + name
    replaceCommand(text + (/^[ \t]/.test(value.slice(slash!.end)) ? '' : ' '), text.length + 1)
  }
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
  } else if (setting) {
    options = setting.options.filter(row => !setting.disabled && !row.disabled &&
      Number.isFinite(mentionScore(settingQuery, row.label, row.id, row.description)))
      .sort((a, b) => mentionScore(settingQuery, a.label, a.id, a.description) - mentionScore(settingQuery, b.label, b.id, b.description))
      .map(row => ({ key: row.id, label: row.label, detail: row.description ?? '', icon: 'scan',
        choose: () => { replaceCommand(''); setting.onSelect(row.id) } }))
  } else if (command) {
    options = matching.map(row => ({ key: row.name, label: '/' + row.name, detail: row.description +
      (row.execution === 'terminal' ? ' · Opens terminal' : row.execution === 'unsupported' ? ` · Unavailable: ${row.reason ?? 'Provider support required'}` : row.inputHint ? ` · ${row.inputHint}` : ''), icon: 'wrench',
      choose: () => {
        if (context?.settings?.[row.name.toLowerCase()]) completeCommand(row.name)
        else if (row.execution === 'client' && row.action === 'file') replaceCommand('@file:')
        else if (['setting', 'client', 'terminal', 'unsupported'].includes(row.execution)) {
          const preserveDraft = !slash!.standalone
          if (preserveDraft && row.execution !== 'unsupported') replaceCommand('')
          context!.onChooseCommand(row, preserveDraft)
        } else completeCommand(row.name)
      } }))
  }
  const status = file ? !projectId ? 'Choose a project to reference its files.' : pathError || error : setting ? setting.error ?? '' : context?.commandsError ?? ''
  return { active: Boolean(file || command || setting), commandMode: Boolean(command || setting), standaloneCommand: slash?.standalone,
    exactCommand: command && slash?.standalone && matching.some(row => '/' + row.name === value.trim() && !context?.settings?.[row.name.toLowerCase()]),
    signature: file ? `file:${projectId}:${file.start}:${file.token}` : `${setting ? 'settings' : 'commands'}:${context?.scope}:${slash?.start}:${query}`,
    heading: file ? `Choose a file${context?.project ? ` · ${context.project.name}` : ''}` : setting?.label ?? 'Commands', options,
    loading: file ? loading : setting ? setting.loading : context?.commandsState === 'loading' && matching.length === 0, error: status,
    disabled: setting?.disabled, footer: setting?.status,
    empty: file ? 'No files match this path.' : setting ? `No ${setting.label === 'Model' ? 'models' : 'options'} match.` : context?.commandsState === 'unsupported' ? 'This backend does not expose commands.' : 'No commands match.',
    loadingText: file ? 'Loading project files…' : setting ? setting.label === 'Model' ? 'Loading models…' : 'Loading setting choices…' : 'Refreshing available commands…' }
}
