import React from 'react'
import Navbar from './Navbar'
import Sidebar from './Sidebar'

type Props = {
  children: React.ReactNode
}

const NAV_H = 64 // px
const SIDEBAR_W = 240 // px

export default function AppShell({ children }: Props) {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Fixed top bar */}
      <div className="fixed top-0 left-0 right-0 h-16 z-40 bg-white border-b">
        <div className="h-full">
          <Navbar />
        </div>
      </div>

      {/* Fixed sidebar (desktop) */}
      <aside
        className="hidden md:block fixed top-16 left-0 bottom-0 z-30 bg-white border-r overflow-y-auto"
        style={{ width: SIDEBAR_W }}
      >
        <Sidebar />
      </aside>

      {/* Main scrollable content area */}
      <main
        className="pt-20 md:pt-20 px-4 md:px-6 pb-10 overflow-x-hidden"
        style={{ marginLeft: SIDEBAR_W, maxWidth: '100%' }}
      >
        {/* On small screens, there’s no fixed sidebar, so remove the left margin */}
        <div className="md:hidden -ml-4 -mr-4">
          {/* keeps spacing consistent when sidebar collapses */}
        </div>

        {/* Actual page */}
        <div className="max-w-screen-xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  )
}
