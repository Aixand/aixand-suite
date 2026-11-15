import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Dialog } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { Catalog as PromptCatalog, Pack, Prompt } from '../prompts/model'
import { defaultInputs, parseInputs } from '../prompts/presentation'
import { PromptInputs } from '../prompts/PromptInputs'
import type { Skill, SkillCatalog } from '../skills/SkillsPage'
import type { ComposerMentionGroup } from './composerMentions'

// Catalogs are requested when the mention picker opens, without preparing a chat.
function useMentionCatalog<T>(agents: AgentsModel, operation: string, event: string, collection: string) {
  const api = useRef(agents); api.current = agents
  const [catalog, setCatalog] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requested = useRef(false)
  const loaded = useRef(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const open = useCallback((refresh = false) => {
    requested.current = true
    if (api.current.status !== 'connected' || !refresh && (loaded.current || pending.current)) return
    const attempt = ++generation.current
    pending.current = true; setLoading(true)
    void api.current.request<T>(operation).then(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('This connection does not provide this resource catalog.')
      if (!Array.isArray((value as Record<string, unknown>)[collection])) throw new Error('This connection returned an invalid resource catalog.')
      if (generation.current === attempt) { setCatalog(value); setError('') }
    }).catch((cause: unknown) => {
      if (generation.current === attempt) setError(cause instanceof Error ? cause.message : 'Could not load suggestions.')
    }).finally(() => {
      if (generation.current === attempt) { pending.current = false; loaded.current = true; setLoading(false) }
    })
  }, [operation, collection])
  useEffect(() => {
    generation.current++; loaded.current = false; pending.current = false; setCatalog(null); setLoading(false); setError('')
    if (agents.status !== 'connected') return
    if (requested.current) open()
    const unsubscribe = agents.subscribe(message => {
      if ((message as { type: string }).type === event && requested.current) open(true)
    })
    return () => { generation.current++; unsubscribe() }
  }, [agents.status, event, open])
  return { catalog, loading, error: agents.status === 'connected' ? error : 'Connect to browse saved resources.', open }
}

type PromptChoice = { pack: Pack; prompt: Prompt }
export function useMentionResources(agents: AgentsModel, scope: string) {
  const prompts = useMentionCatalog<PromptCatalog>(agents, 'prompts-catalog', 'prompts-changed', 'packs')
  const skills = useMentionCatalog<SkillCatalog>(agents, 'skills-catalog', 'skills-changed', 'entries')
  const [selectedPrompt, setSelectedPrompt] = useState<PromptChoice | null>(null)
  const completion = useRef<((text: string | null) => void) | null>(null)
  const finish = useCallback((text: string | null) => {
    completion.current?.(text); completion.current = null; setSelectedPrompt(null)
  }, [])
  useEffect(() => () => finish(null), [scope, finish])
  const choices = (prompts.catalog?.packs ?? []).filter(pack => pack.status === 'available')
    .flatMap(pack => pack.prompts.map(prompt => ({ pack, prompt, id: JSON.stringify([pack.id, prompt.name]) })))
  async function render(choice: PromptChoice, inputs: Record<string, unknown>) {
    const result = await agents.request<{ output: { role: string; content: string }[] }>('prompts-preview', {
      packId: choice.pack.id, prompt: choice.prompt.name, inputs,
    })
    const text = result.output.map(message => message.content).join('\n\n')
    if (!text.trim()) throw new Error('This prompt rendered no text.')
    return text + '\n'
  }
  const groups: ComposerMentionGroup[] = [{
    id: 'prompt', label: 'Prompt', description: 'Insert a saved prompt', icon: 'file-text',
    options: choices.map(choice => ({ id: choice.id, label: choice.prompt.name,
      description: `${choice.pack.name} · ${choice.pack.kind === 'release' ? `Version ${choice.pack.version}` : choice.pack.source} · ${choice.prompt.description}` })),
    loading: prompts.loading, error: prompts.error, onOpen: prompts.open, onRetry: () => prompts.open(true),
    insertText: async id => {
      const choice = choices.find(choice => choice.id === id)
      if (!choice) throw new Error('This prompt is no longer available. Select it again.')
      if (!Object.keys(choice.prompt.inputs).length) return render(choice, {})
      return new Promise<string | null>(resolve => {
        completion.current?.(null); completion.current = resolve; setSelectedPrompt(choice)
      })
    },
  }, {
    id: 'skill', label: 'Skill', description: 'Include saved skill instructions', icon: 'sparkles',
    options: [
      ...(skills.catalog?.entries ?? []).filter(skill => skill.status === 'valid' && !skill.error).map(skill => ({
        id: skill.id, label: skill.name, description: `${skill.source_id} · ${skill.metadata?.description ?? skill.path}`,
      })),
      ...(skills.catalog?.releases ?? []).filter(skill => !skill.error).map(skill => ({
        id: skill.reference, label: skill.name, description: `${skill.source_id} · Version ${skill.version}`,
      })),
    ],
    loading: skills.loading, error: skills.error, onOpen: skills.open, onRetry: () => skills.open(true),
    insertText: async id => {
      const [skill, file] = await Promise.all([
        agents.request<Skill>('skills-show', { entryId: id }),
        agents.request<{ content_b64: string }>('skills-file', { entryId: id, file: 'SKILL.md' }),
      ])
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(file.content_b64), char => char.charCodeAt(0)))
      if (!text.trim()) throw new Error('This skill has no instructions.')
      return `Use the ${skill.name} skill.\nSkill source: ${skill.path}\n\n${text}\n`
    },
  }]
  return { groups, dialog: selectedPrompt && <MentionPromptDialog key={JSON.stringify([selectedPrompt.pack.id, selectedPrompt.prompt.name])}
    choice={selectedPrompt} render={render} onFinish={finish} /> }
}

function MentionPromptDialog({ choice, render, onFinish }: {
  choice: PromptChoice; render: (choice: PromptChoice, inputs: Record<string, unknown>) => Promise<string>
  onFinish: (text: string | null) => void
}) {
  const [values, setValues] = useState(() => defaultInputs(choice.prompt))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  async function insert() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const text = await render(choice, parseInputs(values))
      if (alive.current) onFinish(text)
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not render this prompt.') }
    finally { if (alive.current) setBusy(false) }
  }
  return <Dialog trigger={<Button hidden>Prompt inputs</Button>} title={`Insert ${choice.prompt.name}`} open
    onOpenChange={open => { if (!open) onFinish(null) }} footer={<>
      <Button variant="ghost" onPress={() => onFinish(null)}>Cancel</Button>
      <Button loading={busy} disabled={busy} onPress={() => { void insert() }}>Insert prompt</Button>
    </>}>
    <div className="chat-mention-prompt-inputs"><PromptInputs contracts={choice.prompt.inputs} value={values} onChange={setValues} disabled={busy} label="Prompt inputs (JSON)" /></div>
    {error && <p role="alert">{error}</p>}
  </Dialog>
}
