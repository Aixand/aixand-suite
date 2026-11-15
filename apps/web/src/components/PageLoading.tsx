import { LoadingIndicator } from 'bbb-design'
import './PageLoading.css'

export function PageLoading({ label, size = 'page' }: {
  label: string
  size?: 'page' | 'panel'
}) {
  return (
    <div className={`page-loading page-loading--${size}`}>
      <LoadingIndicator className="page-loading__indicator" label={label} />
    </div>
  )
}
