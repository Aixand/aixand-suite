import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'bbb-design'
import 'bbb-design/styles.css'
import '../styles.css'
import { AuthGate } from '../auth/AuthGate'
import { aixandBrand, aixandWorkspaceTokens } from '../brand'
import { ContentTheme } from '../branding/ContentTheme'
import { RecoveryPicker } from './RecoveryPicker'
import { RecoveryTerminal } from './RecoveryHost'
import { recoveryAppearance } from './appearance'
import './recovery.css'

function terminalFromRoute() {
  try { return location.hash.startsWith('#/terminals/') ? decodeURIComponent(location.hash.slice('#/terminals/'.length)) : '' } catch { return '' }
}

function RecoveryPage() {
  const [terminal, setTerminal] = useState(terminalFromRoute)
  useEffect(() => {
    const change = () => setTerminal(terminalFromRoute())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const open = useCallback((id: string) => { location.hash = `/terminals/${encodeURIComponent(id)}`; setTerminal(id) }, [])
  return <ThemeProvider brand={aixandBrand} mode={recoveryAppearance()} tokens={aixandWorkspaceTokens} className={terminal ? 'recovery-theme' : 'recovery-page'}>
    {terminal ? <RecoveryTerminal sessionId={terminal} onBack={() => { location.hash = ''; setTerminal('') }} /> : <ContentTheme className="aixand-theme-contents">
      <header className="recovery-page-header"><div><h1>Recover a chat</h1><p>Find a saved conversation and continue it in a terminal.</p></div><a href="/#/chat">Return to workspace</a></header>
      <RecoveryPicker initialChatId={new URLSearchParams(location.search).get('chat') ?? undefined} onOpenTerminal={open} />
    </ContentTheme>}
  </ThemeProvider>
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuthGate><RecoveryPage /></AuthGate></StrictMode>)
