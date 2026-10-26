import { profileAccountLabel } from './accountPresentation'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useId, useState } from 'react'
import { Accordion, Button, DescriptionList, Select, Sheet, TextField } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import { ResourcePicker } from './ResourcePicker'
import type { ResourceRequest } from './ResourcePicker'
import type { Project } from '../projects/model'
import { providerLabel } from './presentation'
import type { AgentOperation } from './presentation'

export function LaunchAgentSheet({ agents: a, profile, projects, open, disabled, unavailable, busy, error, act, onOpenChange, onLaunched }: {
  agents: AgentsModel
  profile: Profile
  projects: Project[]
  open: boolean
  disabled: boolean
  unavailable: boolean
  busy: string
  error: string
  act: AgentOperation
  onOpenChange: (open: boolean) => void
  onLaunched: () => void
}) {
  const fieldVariant = useContentFieldVariant()
  const formId = useId()
  const [cwd, setCwd] = useState('')
  const [projectId, setProjectId] = useState('')
  const [model, setModel] = useState('')
  const [resources, setResources] = useState<ResourceRequest>({})
  const [resourcesValid, setResourcesValid] = useState(true)
  const inherited = profile.resources?.mcp.length ?? profile.mcp?.servers.length ?? 0
  const selected = projects.find((project) => project.id === projectId)

  function changeOpen(next: boolean) {
    if (busy) return
    if (next) {
      const directory = a.catalog?.cwd ?? ''
      setCwd(directory)
      setProjectId(projects.find((project) => project.path === directory)?.id ?? '')
      setModel('')
      setResources({})
    }
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={changeOpen} title={`Launch ${profile.profile}`}
      description={`${providerLabel(profile.provider)} · ${profileAccountLabel(profile)}`}
      className="agents-sheet" trigger={<Button variant="secondary" size="sm"
        disabled={disabled || unavailable}>Launch</Button>}
      footer={<>
        <Button variant="ghost" disabled={!!busy} onPress={() => changeOpen(false)}>Cancel</Button>
        <Button type="submit" form={formId} loading={busy === 'launch'}
          disabled={disabled || unavailable || !cwd.trim() || !resourcesValid}>Launch agent</Button>
      </>}>
      <form id={formId} className="agents-sheet-form" onSubmit={(event) => {
        event.preventDefault()
        void act('launch', async () => {
          await a.request('launch', {
            provider: profile.provider, profile: profile.profile, cwd: cwd.trim(),
            ...(model.trim() ? { model: model.trim() } : {}),
            resources,
          })
          onLaunched()
          void a.refreshSessions()
        })
      }}>
        {error && <p role="alert" className="agents-error">{error}</p>}
        {projects.length > 0 && <Select variant={fieldVariant} label="Project" value={projectId} disabled={disabled}
          options={[...projects.map((project) => ({ id: project.id, label: project.name, description: project.path })),
            { id: '', label: 'Enter a directory manually' }]}
          onChange={(value) => {
            setProjectId(value)
            const project = projects.find((item) => item.id === value)
            if (project) setCwd(project.path)
          }} />}
        {selected ? <div className="agents-project-path">
          <p>{selected.path}</p>
          <Button variant="ghost" size="sm" disabled={disabled}
            onPress={() => setProjectId('')}>Enter a directory manually</Button>
        </div> : <TextField variant={fieldVariant} label="Project directory" required value={cwd} disabled={disabled}
          hint="Path to the project on the local machine." onChange={(event) => setCwd(event.target.value)} />}
        <DescriptionList items={[
          { id: 'model', label: 'Model', value: model.trim() || profile.model || 'Profile default' },
          { id: 'tools', label: 'Tools', value: Object.keys(resources).length ? 'Customized for this launch'
            : inherited ? `${inherited} inherited from profile` : 'No tools attached' },
        ]} />
        <Accordion items={[{
          id: 'customize', title: 'Customize this launch', content: <div className="agents-sheet-form">
            <TextField variant={fieldVariant} label="Launch model override" value={model} disabled={disabled}
              hint="Leave empty to use the profile default." onChange={(event) => setModel(event.target.value)} />
            <ResourcePicker agents={a} provider={profile.provider} profile={profile.profile} cwd={cwd} mode="terminal"
              value={resources} onChange={setResources} onValidationChange={setResourcesValid} disabled={disabled} />
          </div>,
        }]} />
      </form>
    </Sheet>
  )
}
