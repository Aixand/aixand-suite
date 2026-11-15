import { DescriptionList } from 'bbb-design'
import type { Budget } from './client'

const percent = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 })
const expired = (row: Budget) => row.status === 'stale' || row.resets_at != null && row.resets_at * 1000 <= Date.now()

function reading(row: Budget): string {
  const remaining = row.window ? row.remaining_percent : row.weekly_left
  const text = expired(row) ? 'Needs refresh' : remaining == null ? 'Unavailable' : `${percent(remaining)}% remaining`
  return text + (row.resets_at ? ` · Resets ${new Date(row.resets_at * 1000).toLocaleString()}` : '')
}

export function allowanceSummary(rows?: Budget[], fallback = 'Allowance not checked'): string {
  if (!rows?.length) return fallback
  if (rows.some(row => row.error)) return 'Allowance unavailable'
  const windows = rows.filter(row => row.window)
  if (!windows.length) {
    const weekly = rows.find(row => row.weekly_left != null)
    return weekly ? `${weekly.weekly_left}% weekly allowance remaining` : 'Allowance unavailable'
  }
  if (windows.some(row => row.remaining_percent == null)) return 'Some allowance windows unavailable'
  if (windows.some(expired)) return 'Allowance needs refreshing'
  const limiting = windows.reduce((a, b) => a.remaining_percent! <= b.remaining_percent! ? a : b)
  return `${percent(limiting.remaining_percent!)}% remaining · ${limiting.label ?? limiting.bucket}`
}

export function AllowanceReadings({ rows }: { rows?: Budget[] }) {
  if (!rows?.length) return null
  return <section aria-label="Account allowance windows">
    {rows.some(row => row.error) ? <p className="agents-error">{rows.find(row => row.error)?.error}</p> : <DescriptionList items={rows.map((row, index) => ({
      id: row.bucket ?? String(index), label: row.label ?? 'Weekly allowance',
      value: reading(row),
    }))} />}
    {rows[0].checked_at && <p className="ws-note">Checked {new Date(rows[0].checked_at * 1000).toLocaleString()}</p>}
  </section>
}
