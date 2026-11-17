import { Component, lazy, Suspense, useCallback, useLayoutEffect, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button, Dialog, ThemeProvider } from 'bbb-design'
import { aixandBrand, aixandWorkspaceTokens } from '../brand'
import { ContentTheme } from '../branding/ContentTheme'
import { PageLoading } from '../components/PageLoading'
import { RecoveryPicker } from './RecoveryPicker'
import { currentChatId, reportRecovery, takeRecoveryRequest } from './events'
import type { RecoveryEvent } from './events'
import { recoveryAppearance } from './appearance'
import { recordCrash } from './diagnostics'
import { CrashDiagnostics } from './CrashDiagnostics'

const Terminals = lazy(() => import('../pages/Terminals').then(module => ({ default: module.Terminals })))

export function RecoveryTerminal({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  return <div className="recovery-terminal"><header><Button variant="ghost" onPress={onBack}>Back to recovered sessions</Button><span>Closing this view leaves your terminal running.</span></header>
    <Suspense fallback={<PageLoading label="Loading terminal…" />}><Terminals sessionId={sessionId} /></Suspense></div>
}

export function RecoveryHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [chatId, setChatId] = useState<string>()
  const [terminalId, setTerminalId] = useState<string>()
  const [mode, setMode] = useState(recoveryAppearance)
  useLayoutEffect(() => {
    document.documentElement.dataset.suiteStarted = 'true'
    function handle(value: RecoveryEvent) {
      if (value.kind === 'healthy' || value.kind === 'failure') return
      setMode(recoveryAppearance())
      setChatId(value.chatId ?? currentChatId())
      setOpen(true)
      takeRecoveryRequest()
    }
    const listener = (event: Event) => handle((event as CustomEvent<RecoveryEvent>).detail)
    window.addEventListener('aixand-recovery', listener)
    const pending = takeRecoveryRequest()
    if (pending) handle(pending)
    return () => window.removeEventListener('aixand-recovery', listener)
  }, [])
  const showTerminal = useCallback((id: string) => { setTerminalId(id); setOpen(false) }, [])
  return <>
    <div style={{ display: terminalId ? 'none' : 'contents' }}>{children}</div>
    <ThemeProvider brand={aixandBrand} mode={mode} tokens={aixandWorkspaceTokens} className="recovery-theme">
      {terminalId && <RecoveryTerminal sessionId={terminalId} onBack={() => { setTerminalId(undefined); setOpen(true) }} />}
      <ContentTheme className="aixand-theme-contents"><Dialog title="Recover a chat" description="Find a saved conversation and continue it in a terminal." open={open} onOpenChange={setOpen}
        trigger={<Button style={{ display: 'none' }}>Recover a chat</Button>} closeLabel="Close recovery" className="recovery-dialog" bodyClassName="recovery-dialog-body">
        {open && <RecoveryPicker key={chatId ?? 'all'} initialChatId={chatId} onOpenTerminal={showTerminal} onRetryChat={() => setOpen(false)} showIndependentLink />}
      </Dialog></ContentTheme>
    </ThemeProvider>
  </>
}

export class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    recordCrash('workspace-render', error, info.componentStack || '')
    reportRecovery({ kind: 'crash', chatId: currentChatId() })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <ThemeProvider brand={aixandBrand} mode={recoveryAppearance()} tokens={aixandWorkspaceTokens} className="recovery-page">
      <ContentTheme className="aixand-theme-contents">
      <h1>The workspace couldn’t load</h1><p>Your conversations can still be found through recovery.</p>
      <CrashDiagnostics />
      <Button onPress={() => reportRecovery({ kind: 'open' })}>Recover a chat</Button>
      <p><a href="/recovery.html">Open the independent recovery page</a></p><Button variant="ghost" onPress={() => location.reload()}>Reload workspace</Button>
      </ContentTheme>
    </ThemeProvider>
  }
}
