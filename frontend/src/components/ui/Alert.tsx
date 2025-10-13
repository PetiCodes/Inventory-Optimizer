import React from 'react'

interface AlertProps {
  children: React.ReactNode
  variant?: 'success' | 'error' | 'warning' | 'info'
  className?: string
}

export default function Alert({ 
  children, 
  variant = 'info', 
  className = '' 
}: AlertProps) {
  const baseClasses = 'p-4 rounded-lg border'
  
  const variantClasses = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    warning: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800'
  }

  return (
    <div className={`${baseClasses} ${variantClasses[variant]} ${className}`} role="alert">
      {children}
    </div>
  )
}
