import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import Button from '../components/ui/Button'
import { supabase } from '../lib/supabaseClient'
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

type Summary = { total_qty: number; distinct_products: number; first_date: string | null; last_date: string | null }
type Monthly = { month: string; qty: number }
type ProductRow = { product_id: string; product_name: string; qty: number }

type ApiResp = {
  customer: { id: string; name: string }
  summary: Summary
  monthly: Monthly[]
  products: ProductRow[]
}

export default function CustomerDetail() {
  const { id } = useParams()
  const [data, setData] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token
        if (!token) throw new Error('Not authenticated')
        const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/customers/${id}/overview`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
        setData(json)
      } catch (e: any) {
        setErr(e.message || 'Failed to load customer')
      } finally {
        setLoading(false)
      }
    })()
  }, [id])

  return (
    <AppShell>
      <div className="space-y-6">
        {loading && (<div className="flex items-center space-x-2"><Spinner size="sm" /><span className="text-gray-600">Loading…</span></div>)}
        {err && <Alert variant="error">{err}</Alert>}
        {!loading && !err && data && (
          <>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{data.customer.name}</h1>
              <p className="text-gray-600">Customer analytics overview</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <Card><CardContent className="p-6"><p className="text-sm text-gray-600">Total Qty Purchased</p><p className="text-2xl font-bold text-gray-900">{data.summary.total_qty.toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-6"><p className="text-sm text-gray-600">Distinct Products</p><p className="text-2xl font-bold text-gray-900">{data.summary.distinct_products}</p></CardContent></Card>
              <Card><CardContent className="p-6"><p className="text-sm text-gray-600">First Purchase</p><p className="text-2xl font-bold text-gray-900">{data.summary.first_date ?? '—'}</p></CardContent></Card>
              <Card><CardContent className="p-6"><p className="text-sm text-gray-600">Last Purchase</p><p className="text-2xl font-bold text-gray-900">{data.summary.last_date ?? '—'}</p></CardContent></Card>
            </div>

            <Card>
              <CardHeader>
                <h3 className="text-lg font-semibold text-gray-900">Monthly Purchases (Qty)</h3>
              </CardHeader>
              <CardContent>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.monthly.map(m => ({ ...m, label: m.month.slice(0,7) }))}>
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
              <CardHeader><h3 className="text-lg font-semibold text-gray-900">Products Purchased</h3></CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[60px]">#</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Total Qty</TableHead>
                      <TableHead className="text-right w-[130px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.products.map((p, idx) => (
                      <TableRow key={p.product_id}>
                        <TableCell>{idx + 1}</TableCell>
                        <TableCell className="font-medium">{p.product_name}</TableCell>
                        <TableCell className="text-right">{p.qty}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="secondary" onClick={() => window.open(`/products/${p.product_id}`, '_blank')}>View Product</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {data.products.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-gray-500">No purchases found.</TableCell></TableRow>
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
