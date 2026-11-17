import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { workspaceFetch } from './auth/transport'

type Capabilities = { voice: boolean; vox: boolean }
const CapabilitiesContext = createContext<Capabilities>({ voice: false, vox: false })
export const useCapabilities = () => useContext(CapabilitiesContext)

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [capabilities, setCapabilities] = useState<Capabilities>({ voice: false, vox: false })
  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    async function load() {
      try {
        const response = await workspaceFetch('/api/capabilities', {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) throw new Error('Capabilities unavailable')
        const value: unknown = await response.json()
        if (!value || typeof value !== 'object' || !('voice' in value) || typeof value.voice !== 'boolean')
          throw new Error('Invalid capabilities')
        if (!controller.signal.aborted) setCapabilities({ voice: value.voice, vox: value.voice && 'vox' in value && value.vox === true })
      } catch {
        if (!controller.signal.aborted) retry = setTimeout(() => { void load() }, 5000)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(retry) }
  }, [])
  return <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>
}
