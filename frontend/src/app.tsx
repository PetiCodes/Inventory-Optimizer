import React, { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'

export default function App() {
  const [session, setSession] = useState<null | NonNullable<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    // initial session fetch
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session ?? null)
      setLoading(false)
    })

    // subscribe to auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!mounted) return
      setSession(newSession ?? null)
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  if (loading) return null // or a small loader

  if (session) return <Navigate to="/dashboard" replace />
  return <Navigate to="/login" replace />
}
