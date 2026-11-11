import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CompanionClient } from './client.ts'

interface HostContextValue {
  client: CompanionClient | null
  busy: boolean
  error: string | null
  pair: (link: string) => Promise<void>
  unpair: () => Promise<void>
}

const HostContext = createContext<HostContextValue | null>(null)

export function HostProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<CompanionClient | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void CompanionClient.load().then(saved => {
      if (saved) setClient(new CompanionClient(saved.baseUrl, saved.credential))
      setBusy(false)
    }).catch(failure => {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    })
  }, [])
  const value = useMemo<HostContextValue>(() => ({
    client,
    busy,
    error,
    pair: async link => {
      setBusy(true)
      setError(null)
      try {
        const saved = await CompanionClient.pair(link)
        setClient(new CompanionClient(saved.baseUrl, saved.credential))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
        throw failure
      } finally {
        setBusy(false)
      }
    },
    unpair: async () => {
      await CompanionClient.unpair()
      setClient(null)
    },
  }), [client, busy, error])
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>
}

export function useHost(): HostContextValue {
  const value = useContext(HostContext)
  if (!value) throw new Error('useHost must be used inside HostProvider')
  return value
}
