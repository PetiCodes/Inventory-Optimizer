import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './app'
import Login from './routes/Login'
import Dashboard from './routes/Dashboard'
import { ToastProvider } from './components/ToastProvider'
import './index.css'
import DataUpload from './routes/DataUpload'
import Products from './routes/Products'
import ProductDetail from './routes/ProductDetail'
import Customers from './routes/Customers'
import CustomerDetail from './routes/CustomerDetail'


function Protected({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()
  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Loading...</p>
      </div>
    </div>
  )
  if (!session) return <Login />
  return <>{children}</>
}

const router = createBrowserRouter([
  { path: '/', element: <App /> },
  { path: '/login', element: <Login /> },
  {
    path: '/dashboard',
    element: (
      <Protected>
        <Dashboard />
      </Protected>
    )
  },
  {
    path: '/data-upload',
    element: (
      <Protected>
        <DataUpload />
      </Protected>
    )
  },
  {
    path: '/products',
    element: (
    <Protected>
      <Products />
    </Protected>
    )
  },
  {
    path: '/products/:id',
    element: (
    <Protected>
      <ProductDetail />
    </Protected>
    )
  },
  {
    path: '/customers',
    element: (
    <Protected>
      <Customers />
    </Protected>
    )
  },
  {
    path: '/customers/:id',
    element: (
    <Protected>
      <CustomerDetail />
    </Protected>
    )
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
  </React.StrictMode>
)
