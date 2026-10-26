import { createBrand, type ThemeTokens } from 'bbb-design'
import { aixandPalette } from './branding/palette'

// Colors and wordmark match ../../project-site. BBB provides the shared
// typography, control geometry, motion, and interaction semantics.
export const aixandCanvas = {
  light: aixandPalette.light.canvas,
  dark: aixandPalette.dark.canvas,
}

// All workspace pages share a softer ink hierarchy, including in portaled menus.
export const aixandWorkspaceTokens: ThemeTokens = {
  '--bbb-color-text': 'color-mix(in srgb, var(--bbb-brand-ink) 90%, var(--bbb-color-surface))',
  '--bbb-color-text-secondary': 'color-mix(in srgb, var(--bbb-brand-ink) 66%, var(--bbb-color-surface))',
  '--bbb-color-text-muted': 'var(--bbb-color-text-secondary)',
}

function colorTokens(palette: typeof aixandPalette.light): ThemeTokens {
  return {
    '--bbb-brand-ink': palette.text,
    '--bbb-brand-ember': palette.teal,
    '--bbb-brand-teal': palette.teal,
    '--bbb-brand-sand': palette.muted,
    '--bbb-brand-pearl': palette.canvas,
    '--bbb-color-canvas': 'var(--bbb-brand-pearl)',
    '--bbb-color-surface': palette.surface,
    '--bbb-color-surface-muted': palette.muted,
    '--bbb-color-surface-inset': palette.inset,
    '--bbb-color-surface-warm': palette.muted,
    '--bbb-color-surface-glass': palette.glass,
    '--bbb-color-text': 'var(--bbb-brand-ink)',
    '--bbb-color-text-secondary': palette.secondary,
    '--bbb-color-text-muted': palette.secondary,
    '--bbb-color-border': palette.border,
    '--bbb-color-border-strong': palette.borderStrong,
    '--bbb-color-field-surface': palette.muted,
    '--bbb-color-field-hover-surface': palette.fieldHover,
    '--bbb-color-field-hover-border': palette.borderStrong,
    '--bbb-color-accent': palette.teal,
    '--bbb-color-accent-hover': palette.actionHover,
    '--bbb-color-accent-pressed': palette.actionPressed,
    '--bbb-color-accent-text': palette.actionText,
    '--bbb-color-accent-subtle': palette.muted,
    '--bbb-color-on-accent': palette.onAction,
    '--bbb-color-supporting': palette.secondary,
    '--bbb-color-supporting-hover': palette.text,
    '--bbb-color-supporting-pressed': palette.text,
    '--bbb-color-supporting-subtle': palette.muted,
    '--bbb-color-supporting-subtle-hover': palette.fieldHover,
    '--bbb-color-focus': palette.teal,
    '--bbb-color-scrim': palette.scrim,
    '--bbb-shadow-sm': 'none',
    '--bbb-shadow-control': 'none',
    '--bbb-shadow-primary': 'none',
    '--bbb-shadow-field': 'none',
    '--bbb-shadow-raised': palette.floatingShadow,
  }
}

export const aixandBrand = createBrand({
  id: 'aixand',
  name: 'Aixand',
  logo: {
    type: 'image',
    light: '/brand/aixand-wordmark.svg',
    dark: '/brand/aixand-wordmark-dark.svg',
    label: 'Aixand',
  },
  modes: {
    light: colorTokens(aixandPalette.light),
    dark: colorTokens(aixandPalette.dark),
  },
})
