import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import {
  Alert,
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Select,
  StatusIndicator,
} from 'bbb-design'
import type { Consumer, Details, Pack, Prompt } from './model'
import { fileContent, revisionLabel } from './presentation'
import type { PromptRequest, PromptSelection } from './presentation'
import { PromptEditor } from './PromptEditor'
import { PromptTools } from './PromptTools'
import { ResourceContent } from '../resources/editor/ResourceContent'
import { ResourceFilePicker } from '../resources/editor/ResourceEditor'
import { PageLoading } from '../components/PageLoading'
import { ContentDisclosure } from '../components/ContentDisclosure'

export function PromptDetail({
  pack,
  prompt,
  selection,
  details,
  file,
  onFile,
  packs,
  consumers,
  request,
  connected,
  error,
  onRevision,
  onSaved,
  onChanged,
  onRetry,
  usage,
  initialBindingTarget,
  onManagedCopy,
}: {
  pack: Pack
  prompt?: Prompt
  selection: PromptSelection
  details: Details | null
  file: string
  onFile: (file: string) => void
  packs: Pack[]
  consumers: Consumer[]
  request: PromptRequest
  connected: boolean
  error: string
  onRevision: (pack: Pack) => void
  onSaved: (details: Details) => Promise<void>
  onChanged: (message: string) => Promise<void>
  onRetry: () => void
  usage?: ReactNode
  initialBindingTarget?: string
  onManagedCopy?: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (window.matchMedia('(max-width: 48rem)').matches)
      heading.current?.focus({ preventScroll: true })
    body.current?.scrollTo(0, 0)
  }, [pack.id, selection.prompt])
  const matching = packs.filter(row => row.name === pack.name)
  const revisions = matching.filter(row => matching.filter(value => value.kind === 'draft').length <= 1 || row.kind === 'release' || row.id === pack.id)
  const files = details
    ? [...Object.keys(details.files), 'pack.json'].filter(
        (path, index, all) => all.indexOf(path) === index,
      )
    : []

  const revisionPicker = revisions.length > 1 ? (
            <Select
              label="Prompt revision"
              variant="plain"
              hideLabel
              value={pack.id}
              options={revisions.map((row) => ({
                id: row.id,
                label: revisionLabel(
                  row,
                  revisions.filter((item) => item.kind === 'draft').length > 1,
                ),
              }))}
              onChange={(id) => {
                const next = revisions.find((row) => row.id === id)
                if (next) onRevision(next)
              }}
            />
          ) : (
            <Badge>{revisionLabel(pack)}</Badge>
          )
  return (
    <section className="prompts-detail" aria-label="Prompt details">
      <header className="prompts-detail-heading">
        <div className="prompts-detail-copy">
          <p className="prompts-context">{pack.name}</p>
          <h2 ref={heading} tabIndex={-1}>
            {selection.prompt ?? 'Shared content'}
          </h2>
          {(prompt?.description || pack.description) && (
            <p>{prompt?.description || pack.description}</p>
          )}
        </div>
        <div className="prompts-row-actions">
          {onManagedCopy && <Button variant="secondary" size="sm" disabled={!connected} onPress={onManagedCopy}>Copy into managed library</Button>}

          {pack.kind === 'draft' && pack.editable !== false && (
            <PromptEditor
              pack={pack}
              name={selection.prompt}
              request={request}
              connected={connected}
              onSaved={onSaved}
            />
          )}
          {details && (
            <PromptTools
              key={`${pack.id}/${selection.prompt ?? ''}/${initialBindingTarget ?? ''}`}
              pack={pack}
              prompt={prompt}
              details={details}
              packs={packs}
              consumers={consumers}
              selection={selection}
              request={request}
              connected={connected}
              onChanged={onChanged}
              initialBindingTarget={initialBindingTarget}
            />
          )}
        </div>
      </header>
      <div className="prompts-detail-body" ref={body}>
        {<StatusIndicator tone={pack.status === 'available' ? 'neutral' : 'warning'} label={pack.status === 'available' ? pack.kind === 'draft' ? 'Working draft' : 'Published release' : 'Source needs attention'}/>}
        {details ? (<>
            {error && (<Alert title="Could not refresh this prompt" tone="warning">
                {error}
              </Alert>)}
            {details.inspection_error && (<Alert title="Source needs attention" tone="warning">
                {details.inspection_error}
              </Alert>)}
            <div className="prompts-reader">
              <div className="prompts-reader-toolbar">
                <ResourceFilePicker files={files} value={file} onChange={onFile}/>
                <CopyButton text={fileContent(details, file)} size="sm" variant="ghost"/>
              </div>
              <ResourceContent text={fileContent(details, file)} file={file} label="Prompt content"/>
            </div>
            {usage}
            <ContentDisclosure enabled title="Versions and source">
            {revisionPicker}
            <details className="prompts-metadata">
              <summary>Prompt details</summary>
              <dl className="prompts-contract">
                <div>
                  <dt>Source</dt>
                  <dd>{pack.source}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{revisionLabel(pack)}</dd>
                </div>
                <div>
                  <dt>Digest</dt>
                  <dd>
                    <code>{details.release.digest ?? 'Not resolved'}</code>
                  </dd>
                </div>
                {prompt &&
        Object.entries(prompt.inputs).map(([key, spec]) => (<div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        {spec.type} ·{' '}
                        {'default' in spec
                ? `Default: ${JSON.stringify(spec.default)}`
                : 'Required'}
                        {spec.enum &&
                ` · Options: ${JSON.stringify(spec.enum)}`}
                      </dd>
                    </div>))}
              </dl>
              <details>
                <summary>Manifest and dependencies</summary>
                <pre className="prompts-output">
                  {JSON.stringify({
        manifest: details.manifest,
        dependencies: details.dependencies,
    }, null, 2)}
                </pre>
              </details>
            </details>
            </ContentDisclosure>

          </>) : error ? (<EmptyState headingLevel={3} title="Prompt details unavailable" description={error} action={<Button variant="secondary" disabled={!connected} onPress={onRetry}>
                Try again
              </Button>}/>) : (<PageLoading label="Loading prompt content…" size="panel"/>)}
      </div>
    </section>
  )
}
