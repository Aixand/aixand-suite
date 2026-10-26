import type { ComponentProps } from 'react'
import { ThemeProvider, useThemeAttributes } from 'bbb-design'
import type { ThemeTokens } from 'bbb-design'
import { aixandBrand, aixandWorkspaceTokens } from '../brand'
import './content.css'

// A content boundary also carries these roles into BBB menus and dialogs.
// Keep the brand, onboarding, navigation, and terminal emulator on their own theme.
const darkContentTokens: ThemeTokens = {
  '--bbb-color-text': '#B4B4B4',
  '--bbb-color-text-secondary': '#A4A4A4',
  '--bbb-color-text-muted': '#929292',
  '--bbb-color-accent-text': '#79B4B6',
  '--bbb-color-accent-subtle': '#293436',
  '--bbb-color-supporting': '#A4A4A4',
  '--bbb-color-supporting-hover': '#BFBFBF',
  '--bbb-color-supporting-pressed': '#BFBFBF',
  '--bbb-color-success': '#87B89A',
  '--bbb-color-warning': '#C6AB76',
  '--bbb-color-danger': '#D48C94',
  '--bbb-color-danger-hover': '#E1A4AA',
  '--bbb-color-danger-pressed': '#EDB8BE',
  '--bbb-content-heading': '#BFBFBF',
  '--bbb-content-composer-border': '#646A73',
  '--bbb-content-utility': '#A4A4A4',
  '--bbb-content-utility-hover': '#BFBFBF',
  '--bbb-content-divider': 'color-mix(in srgb, var(--bbb-color-border) 65%, transparent)',
  '--bbb-color-field-hover-border': '#55585C',
  '--bbb-font-size-xs': '0.8125rem',
  '--bbb-font-size-sm': '0.875rem',
  '--bbb-font-size-md': '0.9375rem',
  '--bbb-line-height-body': '1.6',
  '--bbb-letter-spacing-body': '0',
}

type Props = Omit<ComponentProps<typeof ThemeProvider>, 'brand' | 'tokens'> & { enabled?: boolean }

export function ContentTheme({ enabled = true, className = '', ...props }: Props) {
  const theme = useThemeAttributes()
  const dark = enabled && theme['data-bbb-mode'] === 'dark'
  return <ThemeProvider {...props} className={`aixand-content ${className}`}
    data-ax-content={dark ? 'dark' : undefined} tokens={dark ? darkContentTokens : undefined} />
}

/** Supporting forms keep their labels and use BBB's quiet field treatment. */
export function useContentFieldVariant(): 'subtle' | 'outlined' {
  const theme = useThemeAttributes()
  return theme['data-bbb-mode'] === 'dark' ? 'subtle' : 'outlined'
}

// Preserve the workspace palette for navigation and terminal previews, including overlays.
export function WorkspaceTheme({ className = '', ...props }: Omit<Props, 'enabled'>) {
  return <ThemeProvider {...props} brand={aixandBrand}
    tokens={{ ...aixandWorkspaceTokens, '--bbb-content-heading': 'initial', '--bbb-content-composer-border': 'initial' }}
    className={`aixand-theme-contents ${className}`} />
}
