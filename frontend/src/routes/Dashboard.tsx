import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardHeader, CardContent } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import { supabase } from '../lib/supabaseClient'

type Totals = {
  products: number
  customers: number
  sales_12m_qty: number
  sales_12m_revenue: number
}
type AtRiskItem = {
  product_id: string
  product_name: string
  on_hand: number
  weighted_moq: number
  gap: number
}
type AtRiskPage = {
  page: number
  pageSize: number
  total: number
  pages: number
  items: AtRiskItem[]
}
type ApiResp = { totals: Totals; atRisk: AtRiskPage; topProducts?: any[] }

export default function Dashboard() {
  const navigate = useNavigate()

  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // pagination state for At-Risk
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))

      const res = await fetch(
        `${(import.meta as any).env.VITE_API_BASE}/api/dashboard/overview?` + params.toString(),
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const json: ApiResp | { error?: string } = await res.json()
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`)
      setData(json as ApiResp)
    } catch (e: any) {
      setError(e.message || 'Failed to load dashboard')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page, pageSize])

  const fmt = new Intl.NumberFormat()
  const money = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const canPrev = (data?.atRisk?.page ?? 1) > 1
  const canNext = (data?.atRisk?.page ?? 1) < (data?.atRisk?.pages ?? 1)

  return (
    <AppShell>
      <div className="space-y-5 w-full">
        {/* Header + Upload button */}
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-900">Dashboard</h1>
            <p className="text-gray-600 text-sm">Key metrics and stock risk overview</p>
          </div>
          <div className="md:ml-auto">
            <Button size="sm" onClick={() => navigate('/data-upload')}>Upload Data</Button>
          </div>
        </div>

        {error && <Alert variant="error">{error}</Alert>}
        {loading && (
          <div className="flex items-center gap-2 text-gray-600">
            <Spinner size="sm" /> Loading…
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-gray-600">Products</p>
                  <p className="text-xl font-semibold text-gray-900">{fmt.format(data.totals.products)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-gray-600">Customers</p>
                  <p className="text-xl font-semibold text-gray-900">{fmt.format(data.totals.customers)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-gray-600">Sales Qty (last 12)</p>
                  <p className="text-xl font-semibold text-gray-900">{fmt.format(data.totals.sales_12m_qty)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-gray-600">Revenue (last 12)</p>
                  <p className="text-xl font-semibold text-gray-900">$ {money(data.totals.sales_12m_revenue)}</p>
                </CardContent>
              </Card>
            </div>

            {/* At-Risk — paginated like other pages */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">At-Risk of Stockout</h3>
                    <p className="text-xs text-gray-600">
                      Page {data.atRisk.page} of {data.atRisk.pages} &middot; {fmt.format(data.atRisk.total)} total
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" disabled={!canPrev} onClick={() => setPage(p => Math.max(1, p - 1))}>
                      Prev
                    </Button>
                    <Button size="sm" variant="secondary" disabled={!canNext} onClick={() => setPage(p => p + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-sm">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead className="max-w-[280px]">Product</TableHead>
                        <TableHead className="text-right w-20">On&nbsp;Hand</TableHead>
                        <TableHead className="text-right w-24">MOQ</TableHead>
                        <TableHead className="text-right w-16">Gap</TableHead>
                        <TableHead className="text-right w-24">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(data.atRisk.items ?? []).map((r, i) => (
                        <TableRow key={r.product_id}>
                          <TableCell>{(data.atRisk.page - 1) * data.atRisk.pageSize + i + 1}</TableCell>
                          <TableCell className="font-medium whitespace-normal break-words">
                            <div className="text-[13px] leading-tight line-clamp-2">
                              {r.product_name}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{fmt.format(r.on_hand)}</TableCell>
                          <TableCell className="text-right">{fmt.format(r.weighted_moq)}</TableCell>
                          <TableCell className="text-right text-red-600 font-medium">
                            {fmt.format(r.gap)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => navigate(`/products/${r.product_id}`)}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {(data.atRisk.items ?? []).length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-gray-500">No at-risk items.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Top Products section removed per spec */}
          </>
        )}
      </div>
    </AppShell>
  )
}
