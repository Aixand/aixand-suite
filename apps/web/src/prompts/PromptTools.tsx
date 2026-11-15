import { useContentFieldVariant } from '../branding/ContentTheme'
import { useRef, useState } from 'react'
import {
  Alert,
  Button,
  CopyButton,
  Dialog,
  DropdownMenu,
  Select,
  TextField,
  Icon,
} from 'bbb-design'
import type { Consumer, Details, Pack, Prompt } from './model'
import {
  defaultInputs,
  errorMessage,
  parseInputs,
  revisionLabel,
} from './presentation'
import type { PromptRequest, PromptSelection } from './presentation'
import { PromptInputs } from './PromptInputs'

type Tool = 'preview' | 'compare' | 'publish' | 'bind'

export function PromptTools({
  pack,
  prompt,
  details,
  packs,
  consumers,
  selection,
  request,
  connected,
  onChanged,
  initialBindingTarget,
}: {
  pack: Pack
  prompt?: Prompt
  details: Details
  packs: Pack[]
  consumers: Consumer[]
  selection: PromptSelection
  request: PromptRequest
  connected: boolean
  onChanged: (message: string) => Promise<void>
  initialBindingTarget?: string
}) {
  const fieldVariant = useContentFieldVariant()
  const bindButton = useRef<HTMLButtonElement>(null)
  const testButton = useRef<HTMLButtonElement>(null)
  const [tool, setTool] = useState<Tool | null>(null)
  const [values, setValues] = useState(defaultInputs(prompt))
  const [preview, setPreview] = useState<
    { role: string; content: string }[] | null
  >(null)
  const [compareId, setCompareId] = useState('')
  const [difference, setDifference] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [bindingTarget, setBindingTarget] = useState(initialBindingTarget ?? '')
  const [bindingValues, setBindingValues] = useState(defaultInputs(prompt))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const more = useRef<HTMLButtonElement>(null)
  const blocked = !connected || busy
  const options = consumers
    .filter((consumer) => consumer.status === 'available')
    .flatMap((consumer) =>
      consumer.profiles
        .filter((profile) => !profile.error)
        .map((profile) => ({
          consumer,
          profile,
          id: `${consumer.id}/${profile.profile}`,
        })),
    )
  const target = options.find((row) => row.id === bindingTarget)
  const revisions = packs.filter(
    (row) =>
      row.name === pack.name &&
      row.id !== pack.id &&
      row.status === 'available',
  )

  function close() {
    setTool(null)
    setError('')
    const target = tool === 'bind' ? bindButton : tool === 'preview' ? testButton : more
    requestAnimationFrame(() => (target.current ?? more.current)?.focus())
  }
  async function run(action: () => Promise<void>) {
    if (blocked) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function submit() {
    if (tool === 'preview' && prompt) {
      setPreview(null)
      const result = await request<{
        output: { role: string; content: string }[]
      }>('prompts-preview', { ...selection, inputs: parseInputs(values) })
      setPreview(result.output)
    } else if (tool === 'compare' && compareId) {
      setDifference(null)
      const result = await request<{
        changed: boolean
        definition_diff: string
      }>('prompts-diff', { packId: pack.id, beforeId: compareId })
      setDifference(
        result.changed ? result.definition_diff : 'No content changes.',
      )
    } else if (tool === 'publish' && version.trim()) {
      await request('prompts-release', {
        packId: pack.id,
        version: version.trim(),
        expectedDigest: details.release.digest,
      })
      await onChanged(`Published ${pack.name}@${version.trim()}.`)
      close()
    } else if (tool === 'bind' && target && prompt) {
      await request('prompts-bind', {
        consumerId: target.consumer.id,
        profile: target.profile.profile,
        expectedBindingDigest: target.profile.binding_digest,
        packId: pack.id,
        prompt: prompt.name,
        inputs: parseInputs(bindingValues),
      })
      await onChanged(
        `Selected ${pack.reference}/${prompt.name} for ${target.profile.profile}.`,
      )
      close()
    }
  }
  const title =
    tool === 'preview'
      ? `Test ${prompt?.name}`
      : tool === 'compare'
        ? 'Compare pack revisions'
        : tool === 'publish'
          ? `Publish ${pack.name} pack`
          : `Assign ${prompt?.name} to a profile`
  const actionLabel =
    tool === 'preview'
      ? 'Run preview'
      : tool === 'compare'
        ? 'Compare revisions'
        : tool === 'publish'
          ? 'Publish release'
          : 'Assign to profile'

  return (
    <>
      {!!options.length && pack.kind === 'release' && prompt?.instruction_compatible && <Button ref={bindButton} size="sm" disabled={blocked || !options.length}
        onPress={() => { setError(''); setTool('bind') }}>Assign to profile</Button>}
      {prompt && <Button ref={testButton} variant="secondary" size="sm" disabled={blocked || !details.release.digest}
        onPress={() => { setError(''); setPreview(null); setTool('preview') }}>Test prompt</Button>}
      <DropdownMenu
        label="Prompt actions"
        trigger={
          <Button
            ref={more}
            iconOnly
            className="content-utility"
            variant="ghost"
            size="sm"
            aria-label="Prompt actions"
          >
            <Icon name="ellipsis" />
          </Button>
        }
        items={[
          {
            id: 'compare',
            label: 'Compare revisions',
            disabled: blocked || !details.release.digest || !revisions.length,
          },
          {
            id: 'validate',
            label: 'Validate pack',
            disabled: blocked || !details.release.digest,
          },
          ...(pack.kind === 'draft'
            ? [
                {
                  id: 'publish',
                  label: 'Publish pack',
                  disabled: blocked || !details.release.digest,
                },
              ]
            : []),
        ]}
        onAction={(id) => {
          setError('')
          if (id === 'validate') {
            void run(async () => {
              const result = await request<{ examples_passed: number }>(
                'prompts-validate',
                { packId: pack.id },
              )
              await onChanged(
                `Pack is valid. ${result.examples_passed} rendering examples passed.`,
              )
            })
          } else {
            setPreview(null)
            setDifference(null)
            setTool(id as Tool)
          }
        }}
      />
      {error && !tool && (
        <Alert tone="danger" role="alert" title="Could not validate the pack">
          {error}
        </Alert>
      )}
      <Dialog
        trigger={
          <Button hidden className="prompts-dialog-trigger">
            Prompt tools
          </Button>
        }
        title={title}
        description={`${pack.name} · ${revisionLabel(pack)}`}
        className="prompts-dialog"
        bodyClassName="prompts-form"
        open={tool !== null}
        onOpenChange={(next) => {
          if (!next && !busy) close()
        }}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onPress={close}>
              {tool === 'preview' || tool === 'compare' ? 'Close' : 'Cancel'}
            </Button>
            <Button
              loading={busy}
              onPress={() => {
                void run(submit)
              }}
              disabled={
                blocked ||
                !details.release.digest ||
                (tool === 'compare' && !compareId) ||
                (tool === 'publish' && !version.trim()) ||
                (tool === 'bind' && !target)
              }
            >
              {actionLabel}
            </Button>
          </>
        }
      >
        {tool === 'preview' && prompt && (
          <>
            <PromptInputs
              contracts={prompt.inputs}
              value={values}
              onChange={(next) => {
                setValues(next)
                setPreview(null)
              }}
              disabled={busy}
              label="Preview inputs (JSON)"
            />
            {preview && (
              <div className="prompts-preview">
                <div className="prompts-pack-heading">
                  <h3>Rendered prompt</h3>
                  <CopyButton
                    size="sm"
                    variant="ghost"
                    text={preview
                      .map(
                        (message) =>
                          `${message.role.toUpperCase()}\n${message.content}`,
                      )
                      .join('\n\n')}
                  />
                </div>
                {preview.map((message, index) => (
                  <section key={index} aria-label={`${message.role} message`}>
                    <p className="prompts-context">{message.role}</p>
                    <pre
                      className="prompts-output"
                      aria-label={
                        index === 0
                          ? 'Rendered prompt'
                          : `${message.role} content`
                      }
                    >
                      {message.content}
                    </pre>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        {tool === 'compare' && (
          <>
            <p className="prompts-note">
              Comparisons include every prompt and shared file in this pack.
            </p>
            <Select
              label="Compare with"
              variant={fieldVariant}
              value={compareId || null}
              placeholder="Choose a revision"
              disabled={busy}
              options={revisions.map((row) => ({
                id: row.id,
                label: revisionLabel(row, true),
              }))}
              onChange={(next) => {
                setCompareId(next)
                setDifference(null)
              }}
            />
            {difference !== null && (
              <pre className="prompts-output" aria-label="Revision diff">
                {difference}
              </pre>
            )}
          </>
        )}
        {tool === 'publish' && (
          <>
            <p>
              Creates a release from the saved draft, including every prompt and
              shared file in {pack.name}.
            </p>
            <TextField
              label="Release version"
              variant={fieldVariant}
              value={version}
              disabled={busy}
              placeholder="2"
              onChange={(event) => setVersion(event.target.value)}
              autoFocus
            />
            <p className="prompts-note">
              Publishing validates the pack and its examples. Existing profile
              assignments and conversations keep their current revisions.
            </p>
          </>
        )}
        {tool === 'bind' && prompt && (
          <>
            <Select
              label="Consumer profile"
              variant={fieldVariant}
              value={bindingTarget || null}
              placeholder="Choose a profile"
              disabled={busy}
              options={options.map((row) => ({
                id: row.id,
                label: `${row.consumer.label} / ${row.profile.profile}`,
              }))}
              onChange={(next) => {
                setBindingTarget(next)
                const profile = options.find((row) => row.id === next)?.profile
                setBindingValues(
                  JSON.stringify(
                    {
                      ...parseInputs(defaultInputs(prompt)),
                      ...profile?.binding?.inputs,
                    },
                    null,
                    2,
                  ),
                )
              }}
            />
            <PromptInputs
              contracts={prompt.inputs}
              value={bindingValues}
              onChange={setBindingValues}
              disabled={busy}
              label="Default inputs (JSON)"
            />
            <p className="prompts-note">
              Applies to future conversations that explicitly use this profile's
              instructions. Existing conversations keep their saved content.
            </p>
          </>
        )}
        {!connected && (
          <Alert tone="warning" title="Waiting for a connection">
            Reconnect to continue.
          </Alert>
        )}
        {error && (
          <Alert
            tone="danger"
            role="alert"
            title="Could not complete this action"
          >
            {error}
          </Alert>
        )}
      </Dialog>
    </>
  )
}
