import React, { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

interface SidebarItemProps {
  to: string
  children: React.ReactNode
  disabled?: boolean
  tooltip?: string
}

function SidebarItem({ to, children, disabled = false, tooltip }: SidebarItemProps) {
  const location = useLocation()
  const isActive = location.pathname === to

  if (disabled) {
    return (
      <div className="relative group">
        <div className="flex items-center px-3 py-2 text-sm font-medium text-gray-400 cursor-not-allowed">
          {children}
        </div>
        {tooltip && (
          <div className="absolute left-full ml-2 px-2 py-1 text-xs text-white bg-gray-900 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
            {tooltip}
          </div>
        )}
      </div>
    )
  }

  return (
    <Link
      to={to}
      className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
        isActive
          ? 'bg-primary-100 text-primary-700'
          : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
      }`}
    >
      {children}
    </Link>
  )
}

export default function Sidebar() {
  const [isCollapsed, setIsCollapsed] = useState(false)

  return (
    <div className={`bg-white border-r border-gray-200 transition-all duration-300 ${
      isCollapsed ? 'w-16' : 'w-64'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-6">
          {!isCollapsed && (
            <h2 className="text-lg font-semibold text-gray-900">Navigation</h2>
          )}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
        
        <nav className="space-y-1">
          <SidebarItem to="/dashboard">
            <svg className="w-5 h-5 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2-2z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5a2 2 0 012-2h4a2 2 0 012 2v6H8V5z" />
            </svg>
            {!isCollapsed && 'Dashboard'}
          </SidebarItem>
          
          <SidebarItem to="/customers">
            <svg className="w-5 h-5 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            {!isCollapsed && 'Customers'}
          </SidebarItem>

          <SidebarItem to="/products">
            <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              d="M10 6a4 4 0 100 8 4 4 0 000-8zm8 14l-4.35-4.35" />
            </svg>
            {!isCollapsed && 'Products'}
          </SidebarItem>

          <SidebarItem to="/export">
            <svg className="w-5 h-5 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {!isCollapsed && 'Export'}
          </SidebarItem>

        </nav>
      </div>
    </div>
  )
}
