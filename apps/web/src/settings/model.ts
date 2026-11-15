import { useSyncExternalStore } from 'react'

const KEY = 'aixand.debug-mode'
type Settings = { debugMode: boolean; storageError: string }
function readDebugMode() {
  try { return localStorage.getItem(KEY) === 'true' } catch { return false }
}
let settings: Settings = { debugMode: readDebugMode(), storageError: '' }
const listeners = new Set<() => void>()
export function getSettings() { return settings }
function publish(next: Settings) {
  settings = next
  for (const listener of listeners) listener()
}
function storageChanged(event: StorageEvent) {
  if (event.storageArea === localStorage && (event.key === KEY || event.key === null))
    publish({ debugMode: readDebugMode(), storageError: '' })
}
export function subscribeSettings(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', storageChanged)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', storageChanged)
  }
}
export function setDebugMode(debugMode: boolean) {
  let storageError = ''
  try { localStorage.setItem(KEY, String(debugMode)) }
  catch { storageError = 'This setting applies for this visit. Browser storage is unavailable, so it could not be saved.' }
  publish({ debugMode, storageError })
}
export function useSettings() { return useSyncExternalStore(subscribeSettings, getSettings, getSettings) }
