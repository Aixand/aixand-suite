import { StrictMode, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ThemeMode } from 'bbb-design'
import 'bbb-design/styles.css'
import '../../src/styles.css'
import { App } from '../../src/App'
import { OnboardingPreview } from './OnboardingPreview'

function OnboardingFixture() {
  const [mode, setMode] = useState<ThemeMode | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  function open() {
    const stored = localStorage.getItem('aixand.appearance')
    setMode(stored === 'light' || stored === 'dark' ? stored : 'system')
  }
  function close() {
    setMode(null)
    requestAnimationFrame(() => requestAnimationFrame(() => trigger.current?.focus()))
  }
  return <>
    <App />
    <button ref={trigger} type="button" onClick={open} style={{ position: 'fixed', bottom: 8, right: 8, zIndex: 2 }}>Open onboarding preview</button>
    {mode && <OnboardingPreview mode={mode} onClose={close} />}
  </>
}

createRoot(document.getElementById('root')!).render(<StrictMode><OnboardingFixture /></StrictMode>)
