import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import Button from '../components/ui/Button'
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabaseClient'

type Summary = {
  total_qty: number
  distinct_products: number
  first_date: string | null
  last_date: string | null
  total_revenue?: number
  total_gross_profit?: number
}

type ProductRow = {
  product_id: string
  product_name: string
  qty: number
  revenue?: number
  gross_profit?: number
}

type ApiResp = {
  customer: { id: string; name: string }
  summary: Summary
  monthly?: { month: string; qty: number }[]
  products: ProductRow[]
}

type MonthlyPoint = { month: string; total_qty: number }

export default function CustomerDetail() {
  const { id } = useParams()

  // Overview state
  const [data, setData] = useState<ApiResp | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Monthly chart state
  const [mode, setMode] = useState<'last12' | 'year' | 'allyears'>('last12')
  const [year, setYear] = useState<number>(new Date().getFullYear())
  const [monthly, setMonthly] = useState<MonthlyPoint[]>([])
  const [loadingMonthly, setLoadingMonthly] = useState(false)
  const [monthlyErr, setMonthlyErr] = useState<string | null>(null)

  const years = useMemo(() => {
    const y = new Date().getFullYear()
    return Array.from({ length: 8 }, (_, i) => y - i)
  }, [])

  // Helper to attach the Supabase auth token
  async function authFetch(input: string, init?: RequestInit) {
    const token = (await supabase.auth.getSession()).data.session?.access_token
    if (!token) throw new Error('Not authenticated')
    const headers = new Headers(init?.headers || {})
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
  }

  // Load overview (summary + products + maybe monthly)
  useEffect(() => {
    (async () => {
      if (!id) return
      setLoadingMeta(true)
      setErr(null)
      try {
        const res = await authFetch(
          `${(import.meta as any).env.VITE_API_BASE}/api/customers/${id}/overview`
        )
        const json: ApiResp | { error?: string } = await res.json()
        if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`)
        const api = json as ApiResp
        setData(api)

        if (api.monthly?.length) {
          setMonthly(
            api.monthly.map((m) => ({
              month: String(m.month).slice(0, 7),
              total_qty: Number(m.qty || 0),
            }))
          )
        } else {
          setMonthly([])
        }
      } catch (e: any) {
        setErr(e.message || 'Failed to load customer')
        setData(null)
      } finally {
        setLoadingMeta(false)
      }
    })()
  }, [id])

  // Load monthly series
  async function loadMonthly() {
    if (!id) return
    setMonthlyErr(null)
    setLoadingMonthly(true)
    try {
      const params = new URLSearchParams()
      params.set('mode', mode)
      if (mode === 'year') params.set('year', String(year))

      const res = await authFetch(
        `${(import.meta as any).env.VITE_API_BASE}/api/customers/${id}/monthly?` + params.toString()
      )
      const json: any = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

      const pts: MonthlyPoint[] = (json.points ?? []).map((p: any) => ({
        month: String(p.month).slice(0, 7),
        total_qty: Number(p.total_qty || 0),
      }))
      setMonthly(pts)
    } catch (e: any) {
      setMonthlyErr(e.message || 'Failed to load monthly totals')
      setMonthly([])
    } finally {
      setLoadingMonthly(false)
    }
  }

  useEffect(() => {
    loadMonthly()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, mode, year])

  // Formatters
  const fmtMoney = (n?: number) =>
    n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <AppShell>
      <div className="space-y-6">
        {loadingMeta && (
          <div className="flex items-center space-x-2">
            <Spinner size="sm" />
            <span className="text-gray-600">Loading…</span>
          </div>
        )}
        {err && <Alert variant="error">{err}</Alert>}

        {!loadingMeta && !err && data && (
          <>
            {/* Header */}
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{data.customer.name}</h1>
              <p className="text-gray-600">Customer analytics overview</p>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-6">
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Total Qty Purchased</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Number(data.summary.total_qty || 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Distinct Products</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {Number(data.summary.distinct_products || 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">First Purchase</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {data.summary.first_date ?? '—'}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Last Purchase</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {data.summary.last_date ?? '—'}
                  </p>
                </CardContent>
              </Card>

              {/* NEW: Totals */}
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Total Revenue</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {fmtMoney(data.summary.total_revenue)}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-6">
                  <p className="text-sm text-gray-600">Total Gross Profit</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {fmtMoney(data.summary.total_gross_profit)}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Monthly timeline with toggle */}
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900">Monthly Purchases (Qty)</h3>

                  <div className="inline-flex rounded-lg bg-gray-100 p-1 ml-auto">
                    <button
                      className={`px-3 py-1 rounded-md text-sm ${
                        mode === 'last12' ? 'bg-white shadow font-medium' : 'text-gray-600'
                      }`}
                      onClick={() => setMode('last12')}
                    >
                      Last 12 months
                    </button>
                    <button
                      className={`px-3 py-1 rounded-md text-sm ${
                        mode === 'year' ? 'bg-white shadow font-medium' : 'text-gray-600'
                      }`}
                      onClick={() => setMode('year')}
                    >
                      Specific year
                    </button>
                    <button
                      className={`px-3 py-1 rounded-md text-sm ${
                        mode === 'allyears' ? 'bg-white shadow font-medium' : 'text-gray-600'
                      }`}
                      onClick={() => setMode('allyears')}
                    >
                      All years
                    </button>
                  </div>

                  {mode === 'year' && (
                    <select
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
                      value={year}
                      onChange={(e) => setYear(Number(e.target.value))}
                    >
                      {years.map((y) => (
                        <option key={y} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                  )}

                  <Button onClick={loadMonthly} disabled={loadingMonthly}>
                    Refresh
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {monthlyErr && <div className="text-red-600 text-sm mb-3">{monthlyErr}</div>}
                <div className="h-80">
                  {loadingMonthly ? (
                    <div className="flex items-center space-x-2">
                      <Spinner size="sm" />
                      <span className="text-gray-600">Loading…</span>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={monthly.map((m) => ({ ...m, label: m.month }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <Tooltip />
                        <Line type="monotone" dataKey="total_qty" dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Products purchased (now with Revenue & GP) */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">Products Purchased</h3>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[60px]">#</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Total Qty</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Gross Profit</TableHead>
                      <TableHead className="text-right w-[130px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.products ?? []).map((p, idx) => (
                      <TableRow key={p.product_id}>
                        <TableCell>{idx + 1}</TableCell>
                        <TableCell className="font-medium">{p.product_name}</TableCell>
                        <TableCell className="text-right">
                          {Number(p.qty || 0).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {fmtMoney(p.revenue)}
                        </TableCell>
                        <TableCell className="text-right">
                          {fmtMoney(p.gross_profit)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => window.open(`/products/${p.product_id}`, '_blank')}
                          >
                            View Product
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(data.products ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-gray-500">
                          No purchases found.
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
