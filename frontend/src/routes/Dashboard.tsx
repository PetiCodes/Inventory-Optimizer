import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardHeader, CardContent } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'

type Totals = {
  products: number
  customers: number
  sales_12m_qty: number
  sales_12m_revenue: number
}
type AtRisk = {
  product_id: string
  product_name: string
  on_hand: number
  weighted_moq: number
  gap: number
}
type TopProduct = {
  product_id: string
  product_name: string
  qty_12m: number
  revenue_12m: number
  gross_profit_12m: number
}
type ApiResp = { totals: Totals; atRisk: AtRisk[]; topProducts: TopProduct[] }

export default function Dashboard() {
  const navigate = useNavigate()

  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/dashboard/overview`)
      const json: ApiResp = await res.json()
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`)
      setData(json)
    } catch (e: any) {
      setError(e.message || 'Failed to load dashboard')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const fmt = new Intl.NumberFormat()
  const money = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const atRisk = useMemo(() => data?.atRisk ?? [], [data?.atRisk])

  return (
    <AppShell>
      {/* Keep everything within a sane width and avoid page-level horizontal scroll */}
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
            {/* KPIs — compact */}
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

            {/* At-Risk of Stockout — compact table */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-gray-900">At-Risk of Stockout</h3>
                  <span className="text-xs text-gray-600">{fmt.format(atRisk.length)} items</span>
                </div>
              </CardHeader>
              <CardContent>
                {/* isolate any overflow inside the card; never scroll the whole page */}
                <div className="overflow-x-auto">
                  <div className="text-sm">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">#</TableHead>
                          <TableHead className="min-w-[200px]">Product</TableHead>
                          <TableHead className="text-right">On&nbsp;Hand</TableHead>
                          <TableHead className="text-right">Weighted&nbsp;MOQ</TableHead>
                          <TableHead className="text-right">Gap</TableHead>
                          <TableHead className="text-right w-28">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {atRisk.map((r, i) => (
                          <TableRow key={r.product_id}>
                            <TableCell>{i + 1}</TableCell>
                            <TableCell className="font-medium break-words whitespace-normal">
                              {r.product_name}
                            </TableCell>
                            <TableCell className="text-right">{fmt.format(r.on_hand)}</TableCell>
                            <TableCell className="text-right">{fmt.format(r.weighted_moq)}</TableCell>
                            <TableCell className="text-right text-red-600 font-medium">{fmt.format(r.gap)}</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="secondary" onClick={() => navigate(`/products/${r.product_id}`)}>
                                View
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        {atRisk.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center text-gray-500">
                              No at-risk items.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Top Products — compact table */}
            <Card>
              <CardHeader>
                <h3 className="text-base font-semibold text-gray-900">Top Products (last 12 months)</h3>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <div className="text-sm">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">#</TableHead>
                          <TableHead className="min-w-[200px]">Product</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Revenue</TableHead>
                          <TableHead className="text-right">Gross Profit</TableHead>
                          <TableHead className="text-right w-28">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(data.topProducts ?? []).map((p, i) => (
                          <TableRow key={p.product_id}>
                            <TableCell>{i + 1}</TableCell>
                            <TableCell className="font-medium break-words whitespace-normal">{p.product_name}</TableCell>
                            <TableCell className="text-right">{fmt.format(p.qty_12m)}</TableCell>
                            <TableCell className="text-right">$ {money(p.revenue_12m)}</TableCell>
                            <TableCell className="text-right">$ {money(p.gross_profit_12m)}</TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="secondary" onClick={() => navigate(`/products/${p.product_id}`)}>
                                View
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                        {(data.topProducts ?? []).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={6} className="text-center text-gray-500">No products.</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  )
}
