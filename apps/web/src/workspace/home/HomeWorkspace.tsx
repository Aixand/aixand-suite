import { useEffect, useMemo, useState } from 'react'
import { Button, Icon, Link, SearchField } from 'bbb-design'
import { SelectionIndicator, Tab, TabList, TabPanel, TabPanels, Tabs } from 'react-aria-components'
import type { Workspace } from '../model'
import type { SavedWorkflow } from '../../workflows/library'
import type { HomeWork } from './work'

export type WorkspaceTab = 'projects' | 'workflows' | 'terminals' | 'drafts'
const tabs = [
  { id: 'projects', label: 'Projects' }, { id: 'workflows', label: 'Saved workflows' },
  { id: 'terminals', label: 'Terminals' }, { id: 'drafts', label: 'Drafts' },
] as const

export function HomeWorkspace({ workspace: w, workflows, items, tab, onTabChange, query, onQueryChange, onNewProject, onProjectChat, onProjectFiles, onRunWorkflow, onOpen, navigate }: {
  workspace: Workspace; workflows: SavedWorkflow[]; items: HomeWork[]
  tab: WorkspaceTab; onTabChange: (tab: WorkspaceTab) => void; onNewProject: () => void
  query: string; onQueryChange: (query: string) => void
  onProjectChat: (project: Workspace['projects']['projects'][number]) => void
  onProjectFiles: (project: Workspace['projects']['projects'][number]) => void
  onRunWorkflow: (workflow: SavedWorkflow) => void; onOpen: (row: HomeWork) => void; navigate: (route: string) => void
}) {
  const [projectPage, setProjectPage] = useState(0)
  const [projectPageSize, setProjectPageSize] = useState(12)
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 40rem)')
    const medium = window.matchMedia('(max-width: 70rem)')
    const update = () => setProjectPageSize(narrow.matches ? 3 : medium.matches ? 6 : 12)
    update()
    narrow.addEventListener('change', update)
    medium.addEventListener('change', update)
    return () => {
      narrow.removeEventListener('change', update)
      medium.removeEventListener('change', update)
    }
  }, [])
  useEffect(() => { setProjectPage(0) }, [query, projectPageSize])

  const matches = (text: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const projectQuery = query.trim().toLocaleLowerCase()
  const projects = useMemo(() => projectQuery
    ? w.projects.projects.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(projectQuery))
    : w.projects.projects, [w.projects.projects, projectQuery])
  const projectPages = Math.max(1, Math.ceil(projects.length / projectPageSize))
  useEffect(() => { setProjectPage(page => Math.min(page, projectPages - 1)) }, [projectPages])
  const currentProjectPage = Math.min(projectPage, projectPages - 1)
  const projectOffset = currentProjectPage * projectPageSize
  const visibleProjects = projects.slice(projectOffset, projectOffset + projectPageSize)
  const saved = workflows.filter(workflow => matches(`${workflow.draft.name} ${workflow.draft.description}`))
  const terminals = items.filter(item => item.kind === 'terminal' && matches(`${item.title} ${item.context}`))
  const unfinished = items.filter(item => item.recent && !item.needs && !item.running && item.kind !== 'terminal').sort((a, b) => b.recentAt - a.recentAt || a.key.localeCompare(b.key))
  const drafts = unfinished.filter(item => matches(`${item.title} ${item.context}`))
  const counts = { projects: w.projects.projects.length, workflows: workflows.length, terminals: items.filter(item => item.kind === 'terminal').length, drafts: unfinished.length }
  function workCard(row: HomeWork) {
    return <article className="home-workspace-card" key={row.key} data-work-key={row.key}>
      <span className="home-card-symbol"><Icon name={row.kind === 'terminal' ? 'square-terminal' : row.kind === 'workflow' ? 'workflow' : 'messages-square'} /></span>
      <h3>{row.title}</h3><p>{row.reason}</p><span className="home-card-meta">{row.context}</span>
      <div className="home-card-actions"><Link href={`#/${row.route}`} onClick={event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !row.key.startsWith('workflow-draft:')) { event.preventDefault(); onOpen(row) }
      }}>{row.action}<Icon name="arrow-right" /></Link></div>
    </article>
  }
  return <section className="home-workspace" aria-labelledby="home-workspace-heading" id="home-workspace">
    <div className="home-workspace-heading"><h2 id="home-workspace-heading" tabIndex={-1}>Your workspace</h2>
      <Button variant="secondary" size="sm" disabled={w.agents.status !== 'connected'} onPress={onNewProject}><Icon name="plus" />New project</Button>
    </div>
    <Tabs className="home-workspace-content" selectedKey={tab} onSelectionChange={key => { onTabChange(String(key) as WorkspaceTab); onQueryChange('') }}>
      <div className="home-workspace-tools"><TabList aria-label="Workspace sections" className="home-workspace-tabs">
        {tabs.map(item => <Tab id={item.id} key={item.id} className="home-workspace-tab">
          <SelectionIndicator className="bbb-tabs__indicator home-workspace-tab-indicator" />
          <span className="bbb-tabs__label home-workspace-tab-label">{item.label}<span className="home-workspace-tab-count">{counts[item.id]}</span></span>
        </Tab>)}
      </TabList>
        <SearchField label={`Search ${tabs.find(item => item.id === tab)?.label.toLowerCase()}`} placeholder={`Search ${tab === 'workflows' ? 'workflows' : tab}…`} value={query} onChange={onQueryChange} />
      </div>
      <TabPanels className="bbb-tabs__panels home-workspace-panels">
      <TabPanel id="projects" className="bbb-tabs__panel home-workspace-panel">
        {w.projects.error && <p role="status">{w.projects.error}</p>}
        <div className="home-workspace-grid home-project-grid">{visibleProjects.map(project => {
          const activity = items.filter(item => item.context === project.name)
          const requests = activity.filter(item => item.needs).length
          return <article className="home-workspace-card" key={project.id}><span className="home-card-symbol"><Icon name="folder" /></span>
            <h3 title={project.name}>{project.name}</h3><p className="home-project-path" title={project.path}>{project.path}</p>
            {activity.length > 0 && <span className="home-card-meta" data-attention={requests > 0 || undefined}>{requests ? `${requests} ${requests === 1 ? 'item needs' : 'items need'} you` : `${activity.length} active ${activity.length === 1 ? 'item' : 'items'}`}</span>}
            <div className="home-card-actions"><Button variant="ghost" size="sm" onPress={() => onProjectChat(project)} aria-label={`Start chat in ${project.name}`}>Start chat<Icon name="arrow-right" /></Button>
              <Button variant="ghost" size="sm" onPress={() => onProjectFiles(project)} aria-label={`Browse files in ${project.name}`}><Icon name="folder" />Files</Button></div>
          </article>
        })}</div>
        {!projects.length && <div className="home-library-empty"><Icon name="folder" /><h3>{query ? 'No matching projects' : 'No projects yet.'}</h3>
          {!query && <Button variant="secondary" disabled={w.agents.status !== 'connected'} onPress={onNewProject}>Add project<Icon name="plus" /></Button>}
        </div>}
        {projectPages > 1 && <nav className="home-project-pagination" aria-label="Project pages">
          <span role="status">{projectOffset + 1}–{projectOffset + visibleProjects.length} of {projects.length} projects</span>
          <div className="home-project-page-actions">
            <Button variant="ghost" size="sm" iconOnly aria-label="Previous page" disabled={currentProjectPage === 0} onPress={() => setProjectPage(currentProjectPage - 1)}><Icon name="chevron-left" /></Button>
            <span>Page {currentProjectPage + 1} of {projectPages}</span>
            <Button variant="ghost" size="sm" iconOnly aria-label="Next page" disabled={currentProjectPage === projectPages - 1} onPress={() => setProjectPage(currentProjectPage + 1)}><Icon name="chevron-right" /></Button>
          </div>
        </nav>}
      </TabPanel>
      <TabPanel id="workflows" className="bbb-tabs__panel home-workspace-panel"><div className="home-workspace-grid">{saved.map(workflow => <article className="home-workspace-card" key={workflow.id}>
        <span className="home-card-symbol"><Icon name="workflow" /></span><h3>{workflow.draft.name}</h3>{workflow.draft.description && <p>{workflow.draft.description}</p>}
        <span className="home-card-meta">{workflow.draft.nodes.length} steps</span><div className="home-card-actions">
          <Button variant="ghost" size="sm" onPress={() => onRunWorkflow(workflow)} aria-label={`Run ${workflow.draft.name}`}><Icon name="workflow" />Run workflow</Button>
          <Link href={`#/workflows/${encodeURIComponent(workflow.id)}`}>Edit<Icon name="arrow-right" /></Link></div>
      </article>)}</div>{!saved.length && <p className="home-quiet-empty">{query ? 'No matching workflows.' : 'No saved workflows.'}</p>}
        <Button variant="ghost" className="home-library-link" onPress={() => navigate('workflows')}>Open workflow library<Icon name="arrow-right" /></Button>
      </TabPanel>
      <TabPanel id="terminals" className="bbb-tabs__panel home-workspace-panel"><div className="home-workspace-grid">{terminals.map(workCard)}</div>
        {!terminals.length && <p className="home-quiet-empty">{query ? 'No matching terminals.' : 'No active terminals.'}</p>}
        <Button variant="ghost" className="home-library-link" onPress={() => navigate('terminals')}>Open all terminals<Icon name="arrow-right" /></Button>
      </TabPanel>
      <TabPanel id="drafts" className="bbb-tabs__panel home-workspace-panel"><section aria-label="Continue working"><div className="home-workspace-grid">{drafts.map(workCard)}</div>
        {!drafts.length && <p className="home-quiet-empty">{query ? 'No matching drafts.' : 'No drafts.'}</p>}
      </section></TabPanel>
      </TabPanels>
    </Tabs>
  </section>
}
