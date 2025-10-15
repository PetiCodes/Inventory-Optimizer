import React, { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { supabase } from '../lib/supabaseClient'
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

type Overview = {
  product: { id: string; name: string }
  monthly: { month: string; qty: number }[]
  seasonality: { month_num: number; avg_qty: number }[]
  topCustomers: { customer_id: string; customer_name: string; qty: number }[]
  pricing: { average_selling_price: number; current_unit_cost: number; current_unit_price: number }
  profit_window: { months: number; total_qty: number; total_revenue: number; unit_cost_used: number; gross_profit: number }
  stats12: { weighted_avg_12m: number; sigma_12m: number }
  inventory: { on_hand: number; backorder: number }
  weighted_moq?: number
}

export default function ProductDetail() {
  const { id } = useParams()
  const [months, setMonths] = useState(12)
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
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id, months])

  const fmt = new Intl.NumberFormat()
  const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const series = useMemo(() => (data?.monthly ?? []).map(m => ({ ...m, label: m.month.slice(0, 7) })), [data?.monthly])

  return (
    <AppShell>
      <div className="space-y-6">
        {err && <Alert variant="error">{err}</Alert>}
        {loading && (<div className="flex items-center gap-2 text-gray-600"><Spinner size="sm" /> Loading…</div>)}

        {!loading && !err && data && (
          <>
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{data.product.name}</h1>
                <p className="text-gray-600">Product analytics & ordering</p>
              </div>
              <div className="md:ml-auto flex items-center gap-2">
                <span className="text-sm text-gray-700">Months:</span>
                {[12, 24, 36, 48].map(m => (
                  <Button key={m} size="sm" variant={m === months ? 'primary' : 'secondary'} onClick={() => setMonths(m)}>{m}</Button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <Card className="md:col-span-1"><CardContent className="p-5"><p className="text-sm text-gray-600">Avg Selling Price (ASP)</p><p className="text-2xl font-bold text-gray-900">{money(data.pricing.average_selling_price)}</p></CardContent></Card>
              <Card className="md:col-span-1"><CardContent className="p-5"><p className="text-sm text-gray-600">Unit Cost (current)</p><p className="text-2xl font-bold text-gray-900">{money(data.pricing.current_unit_cost)}</p></CardContent></Card>
              <Card className="md:col-span-1"><CardContent className="p-5"><p className="text-sm text-gray-600">Qty (last 12)</p><p className="text-2xl font-bold text-gray-900">{fmt.format(data.profit_window.total_qty)}</p></CardContent></Card>
              <Card className="md:col-span-1"><CardContent className="p-5"><p className="text-sm text-gray-600">Gross Profit (last 12)</p><p className="text-2xl font-bold text-gray-900">{money(data.profit_window.gross_profit)}</p></CardContent></Card>
              <Card className="md:col-span-1"><CardContent className="p-5"><p className="text-sm text-gray-600">Weighted MOQ</p><p className="text-2xl font-bold text-gray-900">{fmt.format(Math.round(data.weighted_moq ?? 0))}</p></CardContent></Card>
            </div>

            <Card>
              <CardHeader><h3 className="text-lg font-semibold text-gray-900">Monthly Sales</h3></CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={series}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" />
                      <YAxis />
                      <Tooltip />
                      <Line type="monotone" dataKey="qty" dot={false} stroke="#2563eb" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><h3 className="text-lg font-semibold text-gray-900">Top Customers</h3></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[60px]">#</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.topCustomers ?? []).map((c, i) => (
                      <TableRow key={c.customer_id}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell className="font-medium">{c.customer_name}</TableCell>
                        <TableCell className="text-right">{fmt.format(c.qty)}</TableCell>
                      </TableRow>
                    ))}
                    {(data.topCustomers ?? []).length === 0 && (
                      <TableRow><TableCell colSpan={3} className="text-center text-gray-500">No customers.</TableCell></TableRow>
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
