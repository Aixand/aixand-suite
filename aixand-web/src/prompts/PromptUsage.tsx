import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Dialog, EmptyState } from 'bbb-design'
import type { Catalog, Consumer, Launch, Snapshot } from './model'
import type { Profile } from '../agents/client'
import { profileHref, promptHref } from '../agents/resources'
import { errorMessage } from './presentation'
import type { PromptRequest } from './presentation'

export function PromptProfiles({
  consumers,
  request,
  connected,
  onChanged,
  catalog, profiles = [], filterProfile = '', filterConsumer = '',
}: {
  consumers: Consumer[]
  request: PromptRequest
  connected: boolean
  onChanged: (message: string) => Promise<void>
  catalog?: Catalog | null; profiles?: Profile[]; filterProfile?: string; filterConsumer?: string
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  return (
    <section className="prompts-usage" aria-label="Prompt profiles">
      {consumers.filter(row => !filterConsumer || row.id === filterConsumer).map((consumer) => (
        <Card key={consumer.id} title={consumer.label} headingLevel={2}>
          {consumer.error && (
            <Alert title="Profiles unavailable" tone="warning">
              {consumer.error}
            </Alert>
          )}
          {consumer.profiles.filter(row => !filterProfile || row.profile === filterProfile).map((profile) => (
            <div key={profile.profile} className="prompts-binding">
              <div>
                <strong>{consumer.local && profiles.some(row => row.provider === consumer.provider && row.profile === profile.profile)
                  ? <a href={profileHref(profiles.find(row => row.provider === consumer.provider && row.profile === profile.profile)!)}>{profile.profile}</a> : profile.profile}</strong>
                <p>{profile.binding ? <a href={promptHref(profile.binding.reference, catalog ?? null, { consumer: consumer.id, profile: profile.profile })}>{profile.binding.reference}</a> : 'No prompt assigned'}</p>
                {profile.error && (
                  <p className="prompts-source-error">{profile.error}</p>
                )}
              </div>
              {profile.binding && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!connected || !!busy}
                  loading={busy === `${consumer.id}/${profile.profile}`}
                  aria-label={`Clear assignment for ${profile.profile}`}
                  onPress={() => {
                    setBusy(`${consumer.id}/${profile.profile}`)
                    setError('')
                    void request('prompts-unbind', {
                      consumerId: consumer.id,
                      profile: profile.profile,
                      expectedBindingDigest: profile.binding_digest,
                    })
                      .then(() =>
                        onChanged(
                          `Cleared the assignment for ${profile.profile}.`,
                        ),
                      )
                      .catch((cause: unknown) => setError(errorMessage(cause)))
                      .finally(() => setBusy(''))
                  }}
                >
                  Clear assignment
                </Button>
              )}
            </div>
          ))}
          {!consumer.profiles.some(row => !filterProfile || row.profile === filterProfile) && (
            <p className="prompts-note">No profiles available.</p>
          )}
        </Card>
      ))}
      {error && (
        <Alert
          tone="danger"
          role="alert"
          title="Could not clear the assignment"
        >
          {error}
        </Alert>
      )}
      {!consumers.length && (
        <EmptyState
          headingLevel={2}
          title="No registered profiles"
          description="Register a consumer with Prompt Manager to see its profile assignments."
        />
      )}
    </section>
  )
}

function SavedLaunch({
  consumer,
  launch,
  request,
  connected,
}: {
  consumer: Consumer
  launch: Launch
  request: PromptRequest
  connected: boolean
}) {
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let active = true
    setSnapshot(null)
    setError('')
    void request<Snapshot>('prompts-snapshot', {
      consumerId: consumer.id,
      launchId: launch.id,
    })
      .then((value) => {
        if (active) setSnapshot(value)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [open, consumer.id, launch.id, request])
  return (
    <Dialog
      trigger={
        <Button
          variant="ghost"
          size="sm"
          disabled={!connected || launch.status === 'invalid'}
          aria-label={`Inspect saved launch ${launch.id}`}
        >
          Inspect
        </Button>
      }
      open={open}
      onOpenChange={setOpen}
      title="Saved instructions"
      description={`${consumer.label} · ${launch.profile ?? 'Unknown profile'}`}
      className="prompts-dialog"
      bodyClassName="prompts-form"
      footer={(close) => (
        <Button variant="secondary" onPress={close}>
          Close
        </Button>
      )}
    >
      {snapshot ? (
        <>
          <p className="prompts-note">
            {snapshot.instructions?.reference ??
              'No managed prompt was saved with this conversation.'}
          </p>
          {snapshot.instructions && (
            <pre
              className="prompts-content"
              aria-label="Saved developer instructions"
            >
              {snapshot.instructions.developer_instructions}
            </pre>
          )}
          <details className="prompts-metadata">
            <summary>Saved provenance</summary>
            <pre className="prompts-output">
              {JSON.stringify(
                {
                  status: snapshot.status,
                  thread_id: snapshot.thread_id,
                  provenance: snapshot.instructions?.provenance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      ) : error ? (
        <Alert
          title="Could not load saved instructions"
          tone="danger"
          role="alert"
        >
          {error}
        </Alert>
      ) : (
        <p role="status">Loading saved instructions…</p>
      )}
    </Dialog>
  )
}

export function PromptHistory({
  catalog,
  request,
  connected,
  filterProfile = '', filterThread = '', filterProvider = '',
}: {
  catalog: Catalog | null
  request: PromptRequest
  connected: boolean
  filterProfile?: string; filterThread?: string; filterProvider?: string
}) {
  const [history, setHistory] = useState<Record<string, Launch[]>>({})
  const [offsets, setOffsets] = useState<Record<string, number | null>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setHistory({})
    setOffsets({})
  }, [catalog?.checked_at])
  const consumers = (catalog?.consumers ?? []).filter(row => !filterProvider || row.local && row.provider === filterProvider)
  return (
    <section className="prompts-usage" aria-label="Prompt history">
      {consumers.map((consumer) => (
        <Card key={consumer.id} title={consumer.label} headingLevel={2}>
          {consumer.error && (
            <Alert title="History unavailable" tone="warning">
              {consumer.error}
            </Alert>
          )}
          {[...consumer.launches, ...(history[consumer.id] ?? [])].filter(row => (!filterProfile || row.profile === filterProfile) && (!filterThread || row.thread_id === filterThread)).map(
            (launch) => (
              <div key={launch.id} className="prompts-binding">
                <div>
                  <strong>{launch.profile ?? 'Unknown profile'}</strong>{' '}
                  <Badge>{launch.status}</Badge>
                  <p>{launch.reference ?? 'No managed prompt'}</p>
                  {launch.thread_id && (
                    <code className="prompts-note">{launch.thread_id}</code>
                  )}
                  {launch.error && (
                    <p className="prompts-source-error">{launch.error}</p>
                  )}
                </div>
                <SavedLaunch
                  consumer={consumer}
                  launch={launch}
                  request={request}
                  connected={connected}
                />
              </div>
            ),
          )}
          {![...consumer.launches, ...(history[consumer.id] ?? [])].some(row => (!filterProfile || row.profile === filterProfile) && (!filterThread || row.thread_id === filterThread)) && (
            <p className="prompts-note">{filterThread ? 'No saved instructions for this session in the loaded records.' : 'No saved conversations.'}</p>
          )}
          {(offsets[consumer.id] === undefined
            ? consumer.next_offset
            : offsets[consumer.id]) != null && (
            <Button
              variant="secondary"
              size="sm"
              disabled={!connected || !!busy}
              loading={busy === consumer.id}
              onPress={() => {
                setBusy(consumer.id)
                setError('')
                void request<{
                  launches: Launch[]
                  next_offset: number | null
                }>('prompts-history', {
                  consumerId: consumer.id,
                  offset: offsets[consumer.id] ?? consumer.next_offset,
                })
                  .then((result) => {
                    setHistory((current) => ({
                      ...current,
                      [consumer.id]: [
                        ...(current[consumer.id] ?? []),
                        ...result.launches,
                      ],
                    }))
                    setOffsets((current) => ({
                      ...current,
                      [consumer.id]: result.next_offset,
                    }))
                  })
                  .catch((cause: unknown) => setError(errorMessage(cause)))
                  .finally(() => setBusy(''))
              }}
            >
              Load more records
            </Button>
          )}
        </Card>
      ))}
      {error && (
        <Alert title="Could not load more records" tone="danger" role="alert">
          {error}
        </Alert>
      )}
      {!consumers.length && (
        <EmptyState
          headingLevel={2}
          title="No conversation history"
          description="Saved instructions will appear here when a registered consumer uses a prompt."
        />
      )}
    </section>
  )
}
