import React, { useEffect, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent } from '../components/ui/Card'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import { supabase } from '../lib/supabaseClient'
import Button from '../components/ui/Button'

type Summary = {
  totalProducts: number
  totalSalesQty: number
  uniqueCustomers: number
  latestMonthQty: number
}

export default function Dashboard() {
  const [data, setData] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token
        if (!token) throw new Error('Not authenticated')

        const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/dashboard/summary`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
        setData(json)
      } catch (e: any) {
        setErr(e.message || 'Failed to fetch dashboard data')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const kpis = data
    ? [
        { title: 'Total Products', value: data.totalProducts },
        { title: 'Total Sales (Qty)', value: data.totalSalesQty },
        { title: 'Unique Customers', value: data.uniqueCustomers },
        { title: 'Latest Month Sales', value: data.latestMonthQty }
      ]
    : []

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-gray-600">
              Live overview of your key sales and product metrics.
            </p>
          </div>
          <div className="flex gap-3">
            <a href="/products">
              <Button>Search Products</Button>
            </a>
            <a href="/data-upload">
              <Button variant="secondary">Upload Data</Button>
            </a>
          </div>
        </div>

        {loading && (
          <div className="flex items-center space-x-2">
            <Spinner size="sm" />
            <span className="text-gray-600">Loading live metrics…</span>
          </div>
        )}
        {err && <Alert variant="error">{err}</Alert>}

        {!loading && !err && data && (
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {kpis.map((kpi, index) => (
                <Card key={index}>
                  <CardContent className="p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-600">{kpi.title}</p>
                        <p className="text-2xl font-bold text-gray-900">{kpi.value.toLocaleString()}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
