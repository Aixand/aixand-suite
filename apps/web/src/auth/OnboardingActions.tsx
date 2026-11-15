import type { ReactNode } from 'react'
import './onboarding-actions.css'

export function OnboardingActions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <footer className={`setup-footer ${className}`}>{children}</footer>
}
