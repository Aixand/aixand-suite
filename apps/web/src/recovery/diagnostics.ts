import { currentChatId } from './events'

const key = 'aixand.crash-reports.v1'
type CrashReport = { time: string; kind: string; chatId?: string; message: string; stack: string; componentStack: string; client: string }
let reports: CrashReport[] = []
try {
  const saved: unknown = JSON.parse(localStorage.getItem(key) || '[]')
  if (Array.isArray(saved)) reports = saved.filter(value => value && typeof value.message === 'string').slice(-5)
} catch { /* Storage may be unavailable; retain reports in memory. */ }

export function recordCrash(kind: string, error: unknown, componentStack = '') {
  try {
    const report: CrashReport = {
      time: new Date().toISOString(), kind, chatId: currentChatId(),
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      stack: (error instanceof Error ? error.stack || '' : '').slice(0, 12000),
      componentStack: componentStack.slice(0, 12000), client: navigator.userAgent,
    }
    reports = [...reports, report].slice(-5)
    try { localStorage.setItem(key, JSON.stringify(reports)) } catch { /* Keep in memory. */ }
  } catch { /* Diagnostics must never interfere with recovery. */ }
}

export function crashReportText() { return JSON.stringify({ schema: 1, reports }, null, 2) }

export function installCrashCapture() {
  window.addEventListener('error', event => {
    if (event.error || event.message) recordCrash('window-error', event.error || event.message)
  })
  window.addEventListener('unhandledrejection', event => recordCrash('unhandled-rejection', event.reason))
}
