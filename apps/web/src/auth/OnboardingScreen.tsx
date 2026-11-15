import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Icon,
  ThemeProvider,
  Tooltip,
  useThemeAttributes,
  type ThemeMode,
} from 'bbb-design'
import { Dialog, Modal, ModalOverlay } from 'react-aria-components'
import { aixandBrand } from '../brand'
import { AixandSymbol } from '../components/Mark'
import { readStorage } from '../storage'
import './auth.css'
import './onboarding.css'

type Props = {
  title: string
  children?: ReactNode
  steps?: ReactNode
  loading?: boolean
  loadingLabel?: string
  wide?: boolean
  layout?: 'auth' | 'setup'
  mode?: ThemeMode
  onModeChange?: (mode: ThemeMode) => void
  onClose?: () => void
  onReplay?: () => void
  preview?: boolean
  skipIntro?: boolean
}

export function OnboardingScreen(props: Props) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (props.mode) return props.mode
    try {
      const stored = readStorage('aixand.appearance')
      return stored === 'dark' || stored === 'light' ? stored : 'system'
    } catch { return 'system' }
  })
  useEffect(() => { if (props.mode) setMode(props.mode) }, [props.mode])
  function changeMode(next: ThemeMode) {
    setMode(next)
    if (props.onModeChange) props.onModeChange(next)
    else if (!props.preview) {
      try { localStorage.setItem('aixand.appearance', next) }
      catch { /* Appearance still works for this visit. */ }
    }
  }
  return (
    <ThemeProvider brand={aixandBrand} mode={mode}>
      <WelcomePage {...props} onModeChange={changeMode} />
    </ThemeProvider>
  )
}

function WelcomePage({
  title,
  children,
  steps,
  loading = false,
  loadingLabel = 'Welcome to Aixand',
  wide,
  layout = 'auth',
  onModeChange,
  onClose,
  onReplay,
  preview = false,
  skipIntro = false,
}: Props) {
  const theme = useThemeAttributes()
  const dark = theme['data-bbb-mode'] === 'dark'
  const themeLabel = `Switch to ${dark ? 'light' : 'dark'} theme`
  const [introDone, setIntroDone] = useState(skipIntro)
  const [headerReady, setHeaderReady] = useState(false)
  const [cycle, setCycle] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const mark = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLElement>(null)
  const markPosition = useRef<{ layout: typeof layout; ready: boolean; rect: DOMRect } | null>(null)
  const markMovement = useRef<Animation | null>(null)
  const ready = introDone && !loading
  const fieldsReady = ready && (layout !== 'setup' || headerReady)
  useLayoutEffect(() => {
    const element = mark.current
    if (!element) return
    const previous = markPosition.current
    const changed = previous?.layout !== layout
    const moveHeader = ready && layout === 'setup' && (changed || !previous?.ready)
    if (changed || !ready) {
      markMovement.current?.cancel()
      markMovement.current = null
      setHeaderReady(false)
    }
    if (moveHeader)
      element.closest('.onboarding-overlay')?.scrollTo(0, 0)
    const target = element.getBoundingClientRect()
    if (moveHeader) {
      // Animate the existing mark from its last visible position into the page header.
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setHeaderReady(false)
        const from = previous?.rect
        const x = from ? from.x + from.width / 2 - target.x - target.width / 2 : 0
        const y = from ? from.y - target.y : 36
        const animation = element.animate(
          [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 700, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        )
        animation.id = 'aixand-setup-header'
        markMovement.current = animation
        animation.onfinish = () => {
          if (markMovement.current !== animation) return
          markPosition.current = { layout, ready, rect: element.getBoundingClientRect() }
          setHeaderReady(true)
        }
      } else setHeaderReady(true)
    }
    markPosition.current = { layout, ready, rect: element.getBoundingClientRect() }
  }, [layout, ready, cycle])
  useLayoutEffect(() => {
    const element = mark.current
    const area = content.current
    if (!element || !area) return
    const remember = () => {
      if (markPosition.current && markMovement.current?.playState !== 'running')
        markPosition.current.rect = element.getBoundingClientRect()
    }
    const observer = new ResizeObserver(remember)
    observer.observe(element)
    observer.observe(area)
    const overlay = element.closest('.onboarding-overlay')
    overlay?.addEventListener('scroll', remember, { passive: true })
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const reduce = () => {
      if (motion.matches) {
        markMovement.current?.cancel()
        markMovement.current = null
        setHeaderReady(markPosition.current?.layout === 'setup')
      }
    }
    motion.addEventListener('change', reduce)
    return () => {
      observer.disconnect()
      overlay?.removeEventListener('scroll', remember)
      motion.removeEventListener('change', reduce)
      markMovement.current?.cancel()
      markMovement.current = null
      markPosition.current = null
    }
  }, [cycle])
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const finish = () => setIntroDone(true)
    if (motion.matches) finish()
    const timer = window.setTimeout(finish, 1600)
    const change = () => {
      if (motion.matches) finish()
    }
    motion.addEventListener('change', change)
    return () => {
      clearTimeout(timer)
      motion.removeEventListener('change', change)
    }
  }, [cycle])
  useEffect(() => {
    if (fieldsReady) {
      if (layout === 'setup') content.current?.querySelector('.onboarding-fields-inner')?.scrollTo(0, 0)
      heading.current?.focus({ preventScroll: true })
    }
  }, [fieldsReady, title, layout])

  return (
    <ModalOverlay
      {...theme}
      className="bbb-theme onboarding-overlay"
      isOpen
      isDismissable={false}
      isKeyboardDismissDisabled={!onClose}
      onOpenChange={(open) => {
        if (!open) onClose?.()
      }}
    >
      <Modal className="onboarding-modal">
        <Dialog
          className="onboarding-page"
          aria-label={fieldsReady ? title : layout === 'setup' && ready ? 'Preparing agent setup' : 'Starting Aixand Suite'}
        >
          <main
            className="onboarding-stage"
            data-phase={ready ? 'ready' : introDone ? 'waiting' : 'intro'}
            data-layout={layout}
            data-header-phase={layout === 'setup' && !headerReady ? 'moving' : 'ready'}
          >
            <div className="onboarding-topline">
              {onClose && <span className="onboarding-preview-label">
                {preview ? 'Onboarding preview' : 'Agent setup'}
              </span>}
              <div className="onboarding-topline-actions">
                <Tooltip content={themeLabel}>
                  <Button variant="ghost" iconOnly aria-label={themeLabel} onPress={() => onModeChange?.(dark ? 'light' : 'dark')}>
                    <Icon name={dark ? 'sun' : 'moon'} />
                  </Button>
                </Tooltip>
                {onClose && (
                  <Button
                    variant="ghost"
                    iconOnly
                    aria-label={preview ? 'Close onboarding preview' : 'Set up later'}
                    onPress={onClose}
                  >
                    <Icon name="x" />
                  </Button>
                )}
              </div>
            </div>
            <section
              ref={content}
              className={`auth-content onboarding-content${wide ? ' onboarding-content--wide' : ''}`}
            >
              <div
                className="onboarding-splash"
                role={ready ? undefined : 'status'}
                aria-live={ready ? undefined : 'polite'}
              >
                <div ref={mark} className="onboarding-mark" key={cycle}>
                  <AixandSymbol animated={!introDone} />
                </div>
                <div className="onboarding-loading">
                  <div>
                    <p className="onboarding-loading-label">{loadingLabel}</p>
                  </div>
                </div>
              </div>
              <div
                className="onboarding-fields"
                inert={!fieldsReady}
                aria-hidden={!fieldsReady}
              >
                <div className="onboarding-fields-inner">
                  <div className="onboarding-fields-body">
                    <p className="auth-brand">Aixand Suite</p>
                    {steps}
                    <h1 ref={heading} tabIndex={-1}>
                      {title}
                    </h1>
                    {children}
                  </div>
                </div>
              </div>
            </section>
            <footer className="onboarding-footer" inert={layout === 'setup' && !headerReady} aria-hidden={layout === 'setup' && !headerReady}>
              <span>
                {preview
                  ? 'Preview only. No changes are saved.'
                  : 'Aixand Suite'}
              </span>
              {onReplay && ready && (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    onReplay?.()
                    setIntroDone(false)
                    setCycle((value) => value + 1)
                  }}
                >
                  <Icon name="refresh-cw" />
                  Replay animation
                </Button>
              )}
            </footer>
          </main>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
