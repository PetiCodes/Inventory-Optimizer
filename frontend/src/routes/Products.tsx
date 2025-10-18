import React, { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Input from '../components/ui/Input'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

type Row = {
  id: string
  name: string
  qty_12m: number
  revenue_12m: number
  gross_profit_12m: number
}

const fmtCurrency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)

const fmtNumber = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

export default function Products() {
  const navigate = useNavigate()

  // search (debounced)
  const [typing, setTyping] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(typing.trim()), 300)
    return () => clearTimeout(t)
  }, [typing])

  // paging & order
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [order, setOrder] = useState<'gp_desc' | 'gp_asc'>('gp_desc')

  // data state
  const [items, setItems] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // refetch when inputs change
  useEffect(() => {
    fetchPage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, order])

  async function fetchPage() {
    setLoading(true)
    setError(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      params.set('order', order)
      if (q) params.set('q', q)

      const res = await fetch(
        `${(import.meta as any).env.VITE_API_BASE}/api/products/list?` + params.toString(),
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

      setItems(json.items ?? [])
      setTotal(json.total ?? 0)
      setPages(json.pages ?? 1)
    } catch (e: any) {
      setError(e.message || 'Failed to load products')
      setItems([])
      setTotal(0)
      setPages(1)
    } finally {
      setLoading(false)
    }
  }

  // reset to page 1 on new search/order
  useEffect(() => { setPage(1) }, [q, order])

  const headerNote = useMemo(
    () => (loading ? 'Loading…' : `Found ${total} items`),
    [loading, total]
  )

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <div className="md:ml-auto w-full md:w-[420px]">
            <Input
              label="Search product"
              placeholder="Type product name…"
              value={typing}
              onChange={e => setTyping(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 md:ml-2">
            <Button
              variant="secondary"
              onClick={() => setOrder(o => (o === 'gp_desc' ? 'gp_asc' : 'gp_desc'))}
              title="Toggle ranking: Top ↔ Worst"
            >
              {order === 'gp_desc' ? 'Show Worst First' : 'Show Top First'}
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="text-sm text-gray-600">{headerNote}</div>
          </CardHeader>
          <CardContent>
            {error && <Alert variant="error">{error}</Alert>}

            {loading ? (
              <div className="flex items-center gap-2 text-gray-600">
                <Spinner size="sm" /> Loading…
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[64px]">#</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right w-[120px]">Qty (12m)</TableHead>
                      <TableHead className="text-right w-[160px]">Revenue (12m)</TableHead>
                      <TableHead className="text-right w-[160px]">Gross Profit (12m)</TableHead>
                      <TableHead className="text-right w-[120px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(items ?? []).map((p, i) => (
                      <TableRow key={p.id}>
                        <TableCell>{(page - 1) * limit + i + 1}</TableCell>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-right">{fmtNumber(p.qty_12m)}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(p.revenue_12m)}</TableCell>
                        <TableCell className="text-right">{fmtCurrency(p.gross_profit_12m)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" onClick={() => navigate(`/products/${p.id}`)}>
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {((items ?? []).length === 0 && !loading && !error) && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-gray-500">
                          No products found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                {/* Pagination */}
                <div className="mt-4 flex items-center justify-between">
                  <div className="text-sm text-gray-600">
                    Page {page} of {pages}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={page <= 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={page >= pages}
                      onClick={() => setPage(p => Math.min(pages, p + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
