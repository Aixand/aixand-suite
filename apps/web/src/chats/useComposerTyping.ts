import { useEffect, type RefObject } from 'react'

const interactive = 'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="slider"], [role="tree"], [role="grid"], [role="tablist"], .xterm, .cm-editor, .monaco-editor'
const overlay = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-overlay-container]'

// Move focus before the browser inserts text, preserving native input events,
// keyboard layouts, selection replacement and the first typed character.
export function useComposerTyping(inputRef: RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    function focus(event: KeyboardEvent | CompositionEvent) {
      const input = inputRef.current
      if (!input || input.readOnly || input.disabled || !input.getClientRects().length || event.defaultPrevented) return
      if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || event.altKey ||
        !(event.key.length === 1 || event.key === 'Process' || event.key === 'Unidentified' && event.isComposing))) return
      if (document.querySelector(overlay) || !window.getSelection()?.isCollapsed) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest(interactive)) return
      input.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', focus)
    document.addEventListener('compositionstart', focus)
    return () => {
      document.removeEventListener('keydown', focus)
      document.removeEventListener('compositionstart', focus)
    }
  }, [inputRef, enabled])
}
