import { crashReportText } from './diagnostics'

export function CrashDiagnostics() {
  return <details><summary>Crash diagnostics</summary>
    <p>Copy this report to help investigate a failure. Reports include error details and chat IDs; review before sharing. The latest five reports are kept on this device across reloads.</p>
    <textarea aria-label="Saved crash report" readOnly value={crashReportText()} rows={12}
      style={{ width: '100%', boxSizing: 'border-box' }} onFocus={event => event.currentTarget.select()} />
  </details>
}
