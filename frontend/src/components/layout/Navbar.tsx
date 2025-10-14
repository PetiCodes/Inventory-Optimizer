import React, { useEffect, useState } from 'react'
import Button from '../ui/Button'
import { supabase } from '../../lib/supabaseClient'

type UserInfo = { email?: string | null }

export default function Navbar() {
  const [user, setUser] = useState<UserInfo | null>(null)

  useEffect(() => {
    let mounted = true

    // initial load
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setUser({ email: data.session?.user?.email ?? null })
    })

    // subscribe to changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return
      setUser({ email: session?.user?.email ?? null })
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <header className="sticky top-0 z-40 h-14 w-full border-b bg-white/80 backdrop-blur">
      <div className="mx-auto max-w-screen-2xl h-full px-4 flex items-center justify-between">
        <div className="font-semibold text-gray-900">Inventory Optimizer</div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600 truncate max-w-[220px]">
            {user?.email ?? '—'}
          </span>
          <Button size="sm" variant="secondary" onClick={signOut}>Logout</Button>
        </div>
      </div>
    </header>
  )
}
