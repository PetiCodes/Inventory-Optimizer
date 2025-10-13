import { Navigate } from 'react-router-dom'
import { useSession } from './lib/SessionProvider'
import AppShell from './components/layout/AppShell'
import React from 'react'

export default function App() {
  const { session } = useSession()
  
  if (session) {
    return <Navigate to="/dashboard" replace />
  }
  
  return <Navigate to="/login" replace />
}
