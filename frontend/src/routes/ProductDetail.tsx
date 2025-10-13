import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import Button from '../components/ui/Button'
import { supabase } from '../lib/supabaseClient'
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'

type Monthly = { month: string; qty: number }
type TopCustomer = { customer_id: string; customer_name: string; qty: number }
type Seasonality = { month_num: number; avg_qty: number }

type Overview = {
  product: { id: string; name: string }
  monthly: Monthly[]
  seasonality: Seasonality[]
  topCustomers: TopCustomer[]
  pricing: { average_selling_price: number; current_unit_cost: number; current_unit_price: number }
  profit_window: { months: number; total_qty: number; total_revenue: number; unit_cost_used: number; gross_profit: number }
  stats12: { weighted_avg_12m: number; sigma_12m: number }
  inventory: { on_hand: number; backorder: number }
}

const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const ALLOWED = [12, 24, 48, 72, 96] // extend as you wish

export default function ProductDetail() {
  const { id } = useParams()
  const [months, setMonths] = useState<number>(12)
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/products/${id}/overview?months=${months}&top=5`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setData(json)
    } catch (e: any) {
      setErr(e.message || 'Failed to load product')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id, months])

  const monthlyChartData = useMemo(
    () => (data?.monthly ?? []).map(m => ({ ...m, label: m.month.slice(0,7) })),
    [data]
  )
  const seasonalityData = useMemo(
    () => (data?.seasonality ?? []).map(s => ({ ...s, label: MONTH_LABEL[s.month_num - 1] })),
    [data]
  )

  return (
    <AppShell>
      <div className="space-y-6">
        {loading && (<div className="flex items-center space-x-2"><Spinner size="sm" /><span className="text-gray-600">Loading…</span></div>)}
        {err && <Alert variant="error">{err}</Alert>}

        {!loading && !err && data && (
          <>
            {/* Header */}
            <div className="flex items-end justify-between flex-wrap gap-4">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{data.product.name}</h1>
                <p className="text-gray-600">Sales, seasonality, prices & profit</p>
              </div>

              {/* Months selector */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Months:</span>
                {ALLOWED.map(m => (
                  <Button key={m} size="sm" variant={months === m ? 'primary' : 'secondary'} onClick={() => setMonths(m)}>
                    {m}
                  </Button>
                ))}
              </div>
            </div>

            {/* Pricing & Profit (concise KPIs; removed previous cards you highlighted) */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <Card><CardContent className="p-6">
                <p className="text-sm text-gray-600">Avg Selling Price (ASP)</p>
                <p className="text-2xl font-bold text-gray-900">{data.pricing.average_selling_price.toFixed(2)}</p>
              </CardContent></Card>
              <Card><CardContent className="p-6">
                <p className="text-sm text-gray-600">Unit Cost (current)</p>
                <p className="text-2xl font-bold text-gray-900">{data.pricing.current_unit_cost.toFixed(2)}</p>
              </CardContent></Card>
              <Card><CardContent className="p-6">
                <p className="text-sm text-gray-600">Qty (last {months})</p>
                <p className="text-2xl font-bold text-gray-900">{data.profit_window.total_qty}</p>
              </CardContent></Card>
              <Card><CardContent className="p-6">
                <p className="text-sm text-gray-600">Gross Profit (last {months})</p>
                <p className="text-2xl font-bold text-gray-900">{data.profit_window.gross_profit.toFixed(2)}</p>
              </CardContent></Card>
            </div>

            {/* Monthly Sales — last N months (zero-filled) */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">Monthly Sales (qty) — last {months} months</h3>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyChartData}>
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

            {/* Seasonality — last 12 months only */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">Seasonality (avg qty by calendar month, last 12 months)</h3>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={seasonalityData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="avg_qty" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Top Customers (up to 5) */}
            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">Top Customers (up to 5)</h3>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Total Qty</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topCustomers.map((c, idx) => (
                      <TableRow key={c.customer_id}>
                        <TableCell>{idx + 1}</TableCell>
                        <TableCell className="font-medium">{c.customer_name}</TableCell>
                        <TableCell className="text-right">{c.qty}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="secondary" onClick={() => window.open(`/customers/${c.customer_id}`, '_blank')}>
                            View Customer
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {data.topCustomers.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-gray-500">No customers yet.</TableCell></TableRow>
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
