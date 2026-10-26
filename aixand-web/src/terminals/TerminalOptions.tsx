import { useRef, useState } from 'react'
import { Button, Dialog, DropdownMenu, Icon, Tooltip } from 'bbb-design'
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider'
import type { CleanupResult } from './connection'

export function TerminalOptions({ connected, busy, finishedCount, refresh, fullscreen, toggleFullscreen, clean }: {
  connected: boolean
  busy: boolean
  finishedCount: number
  refresh: () => void
  fullscreen: boolean
  toggleFullscreen: () => void
  clean: () => Promise<CleanupResult>
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const running = useRef(false)
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<CleanupResult | null>(null)
  const [error, setError] = useState('')
  const complete = result !== null && result.failures.length === 0
  function changeOpen(next: boolean) {
    if (running.current) return
    setOpen(next)
    if (!next) requestAnimationFrame(() => trigger.current?.focus())
  }
  async function cleanup() {
    if (running.current || busy || !connected) return
    running.current = true
    setError('')
    setResult(null)
    try { setResult(await clean()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cleanup failed. Refresh before trying again.') }
    finally { running.current = false }
  }
  return <UNSAFE_PortalProvider getContainer={() => document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.body}>
    <DropdownMenu label="Terminal options" className="tw-options-menu"
      trigger={<Tooltip content="Terminal options"><Button ref={trigger} variant="ghost" size="sm" iconOnly aria-label="Terminal options"><Icon name="ellipsis" /></Button></Tooltip>}
      items={[
        { id: 'refresh', label: 'Refresh terminals', disabled: !connected || busy },
        { id: 'fullscreen', label: fullscreen ? 'Exit fullscreen' : 'Enter fullscreen' },
        { id: 'clean', label: 'Clean up finished terminals', danger: true, leading: <Icon name="trash-2" />, disabled: !connected || busy || finishedCount === 0 },
      ]}
      onAction={id => {
        if (id === 'refresh') refresh()
        else if (id === 'fullscreen') toggleFullscreen()
        else {
          setResult(null)
          setError('')
          requestAnimationFrame(() => setOpen(true))
        }
      }} />
    <Dialog open={open} onOpenChange={changeOpen} role="alertdialog" className="tw-cleanup-dialog"
      trigger={<Button hidden>Open terminal cleanup</Button>}
      title="Clean up finished terminals?"
      description="Remove finished terminals and their output across all groups and filters. Running processes and saved shells are kept."
      footer={<>
        <Button variant="secondary" autoFocus disabled={busy} onPress={() => changeOpen(false)}>{complete ? 'Done' : 'Cancel'}</Button>
        {!complete && <Button variant="danger" loading={busy} disabled={!connected || busy || finishedCount === 0} onPress={() => void cleanup()}>Clean up</Button>}
      </>}
    >
      {!result && !error && <p>{finishedCount} finished {finishedCount === 1 ? 'terminal' : 'terminals'} available to clean up.</p>}
      {error && <p role="alert" className="tw-cleanup-error">{error}</p>}
      {result && <div role={result.failures.length ? 'alert' : 'status'}>
        <p>Removed {result.succeeded.length} {result.succeeded.length === 1 ? 'terminal' : 'terminals'}.{result.failures.length > 0 && ` ${result.failures.length} could not be removed.`}</p>
        {result.failures.length > 0 && <ul className="tw-cleanup-errors">{result.failures.map(failure => <li key={failure.session_id}>{failure.message}</li>)}</ul>}
      </div>}
    </Dialog>
  </UNSAFE_PortalProvider>
}
