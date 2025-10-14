import React from 'react'
import { supabase } from '../../lib/supabaseClient'
import Button from '../ui/Button'

export default function Navbar() {
  const { session } = useSession()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-semibold text-gray-900">
            Inventory Optimizer
          </h1>
        </div>
        
        <div className="flex items-center space-x-4">
          {session?.user?.email && (
            <span className="text-sm text-gray-600">
              {session.user.email}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
          >
            Sign out
          </Button>
        </div>
      </div>
    </nav>
  )
}
