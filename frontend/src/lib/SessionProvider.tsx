import React, { createContext, useEffect, useState } from 'react'
import { supabase } from './supabaseClient'

type Session = NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']> | null
type Ctx = { session: Session }

export const SessionContext = createContext<Ctx>({ session: null })

const SessionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
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

export default SessionProvider
