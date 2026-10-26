import { useId, useRef, useState } from 'react'
import { Button, Card, Checkbox, TextField, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { AgentsModel } from '../agents/model'
import { requestId } from '../terminals/connection'
import { finishReset, readResetNotice, resetPhrase, setPendingReset } from './reset'
import type { ResetScope } from './reset'

export function ResetSettings({ agents }: { agents: AgentsModel }) {
  const theme = useThemeAttributes()
  const descriptionId = useId()
  const [scope, setScope] = useState<ResetScope | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(readResetNotice)
  const [signOutExternalClaude, setSignOutExternalClaude] = useState(false)
  const attempt = useRef<{ scope: ResetScope; key: string } | null>(null)
  const connected = agents.status === 'connected'
  const label = scope === 'chats' ? 'Reset chats only' : 'Reset everything'

  function close() {
    if (busy) return
    attempt.current = null
    setScope(null); setConfirmation(''); setError('')
  }
  function open(value: ResetScope) {
    setScope(value); setConfirmation(''); setError(''); setNotice(''); setSignOutExternalClaude(false)
  }
  async function reset() {
    if (!scope || confirmation !== resetPhrase(scope) || busy || !connected) return
    if (attempt.current?.scope !== scope) attempt.current = { scope, key: requestId() }
    const key = attempt.current.key
    setBusy(true); setError(''); setPendingReset(key)
    try {
      await agents.request('workspace-reset', { scope, key, confirmation,
        ...(scope === 'everything' ? { signOutExternalClaude } : {}) })
      try { finishReset(scope) }
      catch { setError('Server data was reset, but browser data could not be cleared. Allow browser storage and retry to finish the reset.') }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reset the workspace. Try again.')
    } finally { setBusy(false); setPendingReset() }
  }

  return <Card as="section" className="ws-panel settings-reset" title="Reset data" headingLevel={2}>
    <p>Start fresh by clearing chats or resetting your Aixand workspace. Deletion is permanent and affects everyone using this Suite host.</p>
    <div className="settings-reset-row">
      <div><h3>Reset chats only</h3><p>Delete all chats and their activity history. Keep projects, paired devices, saved workflow drafts, and settings.</p></div>
      <Button variant="danger" disabled={!connected || busy} onPress={() => open('chats')}>Reset chats only</Button>
    </div>
    <div className="settings-reset-row">
      <div><h3>Reset everything</h3><p>Delete chats, project registrations, discovery history, device connections, managed agent profiles, saved accounts, and API keys. Clear agent setup progress and this browser’s saved workflows, drafts, and preferences. You’ll set up your agents again.</p></div>
      <Button variant="danger" disabled={!connected || busy} onPress={() => open('everything')}>Reset everything</Button>
    </div>
    <p className="settings-help">Installed CLIs, project files, your workspace password, and provider logins stored outside Agent Manager are kept. Managed agent data is also reset for other tools sharing this Agent Manager home. Stop active chats, agent operations, workflows, and transfers before resetting.</p>
    <p className="settings-help">For a fresh desktop installation, open the Aixand launcher → This computer → Advanced → Reset or remove components. That checklist can also remove the workspace password, provider software, shared provider logins, and independent tools.</p>
    {!connected && <p role="status">Connect to reset saved data. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {notice && <p role="status">{notice}</p>}
    <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={scope !== null}
      isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={(value) => { if (!value) close() }}>
      <Modal className="bbb-modal">
        <Dialog role="alertdialog" className="bbb-dialog settings-reset-dialog" aria-describedby={descriptionId}>
          <div className="bbb-dialog__header">
            <Heading slot="title">{label}?</Heading>
            <p id={descriptionId} className="bbb-dialog__description">{scope === 'chats'
              ? 'Permanently delete every chat and its activity history from this Suite host. Projects, saved workflow drafts, and settings are kept.'
              : 'Permanently delete chats, project registrations, discovery history, device connections, managed agent profiles, saved accounts, API keys, and agent setup progress. This includes managed agent data shared with other tools. Restore defaults and clear this browser’s saved workflows, drafts, and preferences. You’ll set up your agents again.'} This cannot be undone. Project files and installed CLIs are kept.{scope === 'everything' && ' Your workspace password and provider logins stored outside Agent Manager are kept.'}</p>
          </div>
          <form className="bbb-dialog__body settings-reset-form" onSubmit={(event) => { event.preventDefault(); void reset() }}>
            {scope === 'everything' && <>
              <p>Aixand-specific Claude accounts will be signed out through Claude before reset. Existing shared Claude logins are kept unless selected below.</p>
              <Checkbox label="Also sign out existing shared Claude accounts (affects other applications)"
                isSelected={signOutExternalClaude} disabled={busy} onChange={value => {
                  setSignOutExternalClaude(value); attempt.current = null
                }} />
            </>}
            <TextField label={`Type ${scope ? resetPhrase(scope) : ''} to confirm`} value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)} disabled={busy}
              autoComplete="off" spellCheck={false} />
            {error && <p role="alert">{error}</p>}
            <div className="settings-reset-actions">
              <Button variant="ghost" autoFocus disabled={busy} onPress={close}>Cancel</Button>
              <Button type="submit" variant="danger" loading={busy}
                disabled={busy || !connected || !scope || confirmation !== resetPhrase(scope)}>{label}</Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  </Card>
}
