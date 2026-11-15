const shell = 'M0 223 122 6h47l122 217h-59L145 57 59 223Z'
const core = 'm145 135 36 63h-72Z'

export function AixandSymbol({ animated = false }: { animated?: boolean }) {
  if (animated)
    return (
      <span className="onboarding-mark__pieces" aria-hidden="true">
        <svg
          className="onboarding-mark__shell"
          viewBox="0 0 291 230"
          fill="none"
          focusable="false"
        >
          <path d={shell} fill="currentColor" />
        </svg>
        <svg
          className="onboarding-mark__core"
          viewBox="0 0 291 230"
          fill="none"
          focusable="false"
        >
          <path d={core} fill="var(--bbb-brand-teal)" />
        </svg>
      </span>
    )
  return (
    <svg viewBox="0 0 291 230" fill="none" focusable="false" aria-hidden="true">
      <path d={shell} fill="currentColor" />
      <path d={core} fill="var(--bbb-brand-teal)" />
    </svg>
  )
}

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`brand-mark ${small ? 'brand-mark--small' : ''}`}
      aria-hidden="true"
    >
      <AixandSymbol />
    </span>
  )
}
