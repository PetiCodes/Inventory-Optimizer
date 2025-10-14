import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

type Session = NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']> | null

interface SessionContextType {
  session: Session
}

const SessionContext = createContext<SessionContextType>({ session: null })

export const SessionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [session, setSession] = useState<Session>(null)

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setSession(data.session ?? null)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (mounted) setSession(newSession ?? null)
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  return (
    <SessionContext.Provider value={{ session }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  return useContext(SessionContext)
}

export default SessionProvider
