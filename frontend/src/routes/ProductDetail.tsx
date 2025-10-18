import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardHeader, CardContent } from '../components/ui/Card'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import Button from '../components/ui/Button'
import { supabase } from '../lib/supabaseClient'

type MonthlyPoint = { month: string; qty: number }
type CustomerRow = { customer_id: string; customer_name: string; qty: number }

type ApiResp = {
  product: { id: string; name: string }
  monthly: MonthlyPoint[]
  seasonality?: { month_num: number; avg_qty: number }[]
  topCustomers?: CustomerRow[]
  allCustomers?: CustomerRow[]           // <- NEW
  pricing?: {
    average_selling_price: number | null
    current_unit_cost: number | null
    current_unit_price: number | null
  }
  profit_window?: {
    mode: 'last12' | 'year'
    year?: number
    total_qty: number
    total_revenue: number
    unit_cost_used?: number
    gross_profit: number
  }
  stats12?: {
    weighted_avg_12m: number
    sigma_12m: number
    weighted_moq?: number
  }
  inventory?: { on_hand: number; backorder: number } // <- we will show on-hand in KPI
}

export default function ProductDetail() {
  const { id } = useParams()

  const [mode, setMode] = useState<'last12' | 'year'>('last12')
  const [year, setYear] = useState<number>(new Date().getFullYear())

  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const years = useMemo(() => {
    const y = new Date().getFullYear()
    return Array.from({ length: 8 }, (_, i) => y - i)
  }, [])

  async function load() {
    if (!id) return
    setLoading(true)
    setErr(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const params = new URLSearchParams()
      params.set('mode', mode)
      if (mode === 'year') params.set('year', String(year))
      // “top” still sent for backward compat, but we’ll use allCustomers
      params.set('top', '5')

      const res = await fetch(
        `${(import.meta as any).env.VITE_API_BASE}/api/products/${id}/overview?` + params.toString(),
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const json: any = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setData(json as ApiResp)
    } catch (e: any) {
      setErr(e.message || 'Failed to load product')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id, mode, year])

  const asp = data?.pricing?.average_selling_price ?? null
  const unitCost = data?.pricing?.current_unit_cost ?? null
  const weightedMOQ = data?.stats12?.weighted_moq ?? 0
  const sigma12 = data?.stats12?.sigma_12m ?? 0
  const onHand = data?.inventory?.on_hand ?? 0

  const qtyLast12 = useMemo(() => {
    const arr = data?.monthly ?? []
    const last12 = arr.slice(-12)
    return last12.reduce((s, r) => s + Number(r.qty || 0), 0)
  }, [data?.monthly])

  const grossProfit = data?.profit_window?.gross_profit ?? null

  return (
    <AppShell>
      <div className="space-y-6">
        {loading && (
          <div className="flex items-center gap-2 text-gray-600">
            <Spinner size="sm" /> Loading…
          </div>
        )}
        {err && <Alert variant="error">{err}</Alert>}

        {!loading && !err && data && (
          <>
            {/* Header */}
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{data.product.name}</h1>
                <p className="text-gray-600">Product analytics</p>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <div className="inline-flex rounded-lg bg-gray-100 p-1">
                  <button
                    className={`px-3 py-1 rounded-md text-sm ${mode === 'last12' ? 'bg-white shadow font-medium' : 'text-gray-600'}`}
                    onClick={() => setMode('last12')}
                  >
                    Last 12 months
                  </button>
                  <button
                    className={`px-3 py-1 rounded-md text-sm ${mode === 'year' ? 'bg-white shadow font-medium' : 'text-gray-600'}`}
                    onClick={() => setMode('year')}
                  >
                    Specific year
                  </button>
                </div>

                {mode === 'year' && (
                  <select
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                  >
                    {years.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                )}

                <Button size="sm" onClick={load} disabled={loading}>
                  Refresh
                </Button>
              </div>
            </div>

            {/* KPI row 1 */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Avg Selling Price (ASP)</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {asp != null ? Number(asp).toFixed(2) : '—'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Unit Cost (current)</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {unitCost != null ? Number(unitCost).toFixed(2) : '—'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Qty (last 12)</p>
                  <p className="text-2xl font-bold text-gray-900">{qtyLast12.toLocaleString()}</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">
                    Gross Profit ({mode === 'year' ? year : 'last 12'})
                  </p>
                  <p className="text-2xl font-bold text-gray-900">
                    {grossProfit != null ? Number(grossProfit).toFixed(2) : '—'}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* KPI row 2 – Weighted MOQ + σ + On hand */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Weighted MOQ (4 mo)</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Number(weightedMOQ || 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">σ (12m)</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Number(sigma12 || 0).toFixed(2)}
                  </p>
                </CardContent>
              </Card>

              {/* NEW: On-hand inventory KPI */}
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">On hand (current)</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Number(onHand || 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Monthly chart */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">
                  Monthly Sales (Qty) — {mode === 'year' ? year : 'Last 12 months'}
                </h3>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={(data.monthly ?? []).map((m) => ({ ...m, label: String(m.month).slice(0, 7) }))}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" />
                      <YAxis />
                      <Tooltip />
                      <Line type="monotone" dataKey="qty" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* NEW: All customers table with “View” (opens in new tab) */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">
                  Customers ({mode === 'year' ? year : 'last 12 months'})
                </h3>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[60px]">#</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right w-[120px]">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.allCustomers ?? []).map((c, i) => (
                      <TableRow key={c.customer_id}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell className="font-medium">{c.customer_name}</TableCell>
                        <TableCell className="text-right">{Number(c.qty || 0).toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <a
                            href={`/customers/${c.customer_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary-700 hover:underline"
                          >
                            View
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(data.allCustomers ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-gray-500">
                          No customers in this period.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  )
}
