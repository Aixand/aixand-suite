import { useRef, useState } from 'react'
import { Badge, Button, Card, Icon, Textarea } from 'bbb-design'
import { WorkflowList } from '../components/WorkflowList'
import { templates } from '../model'
import type { Workflow } from '../model'

export function Command({
  workflows,
  onCreate,
  onOpen,
  onViewAll,
}: {
  workflows: Workflow[]
  onCreate: (prompt: string, template: string) => void
  onOpen: (id: string) => void
  onViewAll: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [template, setTemplate] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const createWorkflow = () => {
    if (prompt.trim()) onCreate(prompt, template)
  }
  return (
    <div className="command-page">
      <section className="command-intro">
        <div className="intro-label">
          <span className="intro-dot" />
          <span>YOUR NEXT WORKFLOW</span>
        </div>
        <h1 tabIndex={-1}>
          Big ideas.
          <br />
          <span>Clear next steps.</span>
        </h1>
        <p>
          Start with what you want to accomplish. Make the plan yours.
        </p>
      </section>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          createWorkflow()
        }}
      >
        <Textarea
          ref={promptRef}
          label="What would you like to accomplish?"
          rows={3}
          maxLength={4000}
          placeholder="Describe what you want to achieve…"
          value={prompt}
          aria-describedby="composer-hint"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              createWorkflow()
            }
          }}
          onChange={(e) => {
            setPrompt(e.target.value)
            setTemplate('')
          }}
        />
        <div className="composer-footer">
          <span className="composer-note">
            <Icon name="layers" />{' '}
            {template
              ? `${templates.find((item) => item.id === template)?.name} template`
              : 'Review the plan before you run'}
          </span>
          <Button type="submit" disabled={!prompt.trim()}>
            Create workflow <Icon name="arrow-right" />
          </Button>
        </div>
      </form>
      <p className="composer-hint" id="composer-hint">
        <Icon name="eye" /> Edit every step before starting.
        <span className="composer-shortcut">⌘ / Ctrl + Enter to create</span>
      </p>
      <section className="templates-section" aria-labelledby="templates-title">
        <div className="section-label">
          <h2 id="templates-title">Start from a template</h2>
          <span>OR WRITE YOUR OWN ABOVE</span>
        </div>
        <div className="template-grid">
          {templates.map((t) => (
            <Button
              key={t.id}
              variant="ghost"
              className="template-card"
              aria-pressed={template === t.id}
              onPress={() => {
                setPrompt(t.prompt)
                setTemplate(t.id)
                promptRef.current?.focus()
              }}
            >
              <span className="template-top">
                <Icon name={t.icon} />
                <Icon name={template === t.id ? 'check' : 'arrow-right'} />
              </span>
              <strong>{t.name}</strong>
              <span>{t.description}</span>
            </Button>
          ))}
        </div>
      </section>
      <Card
        as="section"
        className="recent-section"
        headingLevel={2}
        title="Recent workflows"
        description="Pick up where you left off."
        action={
          <Button size="sm" variant="ghost" onPress={onViewAll}>
            View all <Icon name="arrow-right" />
          </Button>
        }
      >
        <WorkflowList workflows={workflows.slice(0, 3)} onOpen={onOpen} />
      </Card>
      <div className="demo-note">
        <Badge tone="neutral">Demo workspace</Badge>
        <span>
          Plans and runs stay in this browser. No agents are connected.
        </span>
      </div>
    </div>
  )
}
