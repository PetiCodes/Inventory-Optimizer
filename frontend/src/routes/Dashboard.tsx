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
type ApiResp = { totals: Totals; atRisk: AtRiskItem[]; topProducts?: any[] }

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
      
      // Load dashboard totals
      const totalsRes = await fetch(
        `${(import.meta as any).env.VITE_API_BASE}/api/dashboard/overview`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const totalsJson: { totals: Totals } | { error?: string } = await totalsRes.json()
      if (!totalsRes.ok) throw new Error((totalsJson as any)?.error || `HTTP ${totalsRes.status}`)

  setData({
    totals: (totalsJson as any).totals,
    atRisk: (totalsJson as any).atRisk || [],
    topProducts: []
  })
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

  // Pagination for at-risk products
  const totalPages = useMemo(() => Math.max(1, Math.ceil((data?.atRisk?.length ?? 0) / pageSize)), [data?.atRisk?.length, pageSize])
  const canPrev = page > 1
  const canNext = page < totalPages
  const paginatedAtRisk = useMemo(() => {
    if (!data?.atRisk) return []
    const start = (page - 1) * pageSize
    const end = start + pageSize
    return data.atRisk.slice(start, end)
  }, [data?.atRisk, page, pageSize])


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

            {/* At-Risk — paginated like customers page */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-semibold text-gray-900">At-Risk of Stockout</h3>
                    <div className="text-sm text-gray-600">
                      {loading ? 'Loading…' : `Showing ${paginatedAtRisk.length} of ${data.atRisk.length} products`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canPrev || loading}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      ← Prev
                    </Button>
                    <span className="text-sm text-gray-700">
                      Page {page} / {totalPages}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canNext || loading}
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    >
                      Next →
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-sm">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[64px]">#</TableHead>
                        <TableHead className="max-w-[280px]">Product</TableHead>
                        <TableHead className="text-right w-20">On&nbsp;Hand</TableHead>
                        <TableHead className="text-right w-24">MOQ</TableHead>
                        <TableHead className="text-right w-16">Gap</TableHead>
                        <TableHead className="text-right w-[140px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedAtRisk.map((r, i) => (
                        <TableRow key={r.product_id}>
                          <TableCell>{(page - 1) * pageSize + i + 1}</TableCell>
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
                              onClick={() => window.open(`/products/${r.product_id}`, '_blank')}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {paginatedAtRisk.length === 0 && !loading && !error && (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-gray-500">
                            No at-risk products found.
                          </TableCell>
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
