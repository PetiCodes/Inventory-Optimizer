import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Input from '../components/ui/Input'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import { supabase } from '../lib/supabaseClient'

type ListItem = {
  id: string
  name: string
  qty_12m: number
  revenue_12m: number
  gross_profit_12m: number
}
type ListResp = {
  page: number
  limit: number
  total: number
  pages: number
  items: ListItem[]
}

export default function Products() {
  const API = (import.meta as any).env.VITE_API_BASE as string
  const navigate = useNavigate()

  // search + debounce
  const [typing, setTyping] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(typing.trim()), 300)
    return () => clearTimeout(t)
  }, [typing])

  // paging + sort
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [order, setOrder] = useState<'gp_desc' | 'gp_asc'>('gp_desc')

  // data
  const [items, setItems] = useState<ListItem[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startRank = useMemo(() => (page - 1) * limit, [page, limit])

  useEffect(() => { setPage(1) }, [q, order])
  useEffect(() => { load() }, [page, q, order])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}

      // Preferred: new paginated list endpoint (includes GP ranking)
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      params.set('order', order)
      if (q) params.set('q', q)

      let res = await fetch(`${API}/api/products/list?` + params.toString(), { headers })
      // Fallback: if the list endpoint isn’t available yet, use legacy search so the page isn’t empty
      if (res.status === 404) {
        const p2 = new URLSearchParams()
        p2.set('limit', String(limit))
        if (q) p2.set('q', q)
        res = await fetch(`${API}/api/products/search?` + p2.toString(), { headers })
        const j2 = await res.json()
        if (!res.ok) throw new Error(j2?.error || `HTTP ${res.status}`)
        const list = (j2.results ?? []).map((r: any) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          qty_12m: 0,
          revenue_12m: 0,
          gross_profit_12m: 0,
        })) as ListItem[]
        setItems(list)
        setTotal(list.length)
        setPages(1)
        return
      }

      const json: ListResp | { error?: string } = await res.json()
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`)

      const data = json as ListResp
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      setPages(Math.max(1, data.pages ?? 1))
    } catch (e: any) {
      setError(e.message || 'Failed to load products')
      setItems([])
      setTotal(0)
      setPages(1)
    } finally {
      setLoading(false)
    }
  }

  const canPrev = page > 1
  const canNext = page < pages

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>

          <div className="md:ml-auto flex items-center gap-3 w-full md:w-auto">
            <div className="w-full md:w-[360px]">
              <Input
                label="Search product"
                placeholder="Type product name…"
                value={typing}
                onChange={e => setTyping(e.target.value)}
              />
            </div>

            <select
              className="rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
              value={order}
              onChange={e => setOrder(e.target.value as 'gp_desc' | 'gp_asc')}
              title="Ranking order"
            >
              <option value="gp_desc">Top (by Gross Profit)</option>
              <option value="gp_asc">Worst (by Gross Profit)</option>
            </select>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">
                {loading ? 'Loading…' : `Found ${total} items`}
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={!canPrev || loading} onClick={() => setPage(p => Math.max(1, p - 1))}>
                  Prev
                </Button>
                <span className="text-sm text-gray-600">
                  Page {page} / {pages}
                </span>
                <Button size="sm" variant="secondary" disabled={!canNext || loading} onClick={() => setPage(p => Math.min(pages, p + 1))}>
                  Next
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {error && <Alert variant="error">{error}</Alert>}

            {loading ? (
              <div className="flex items-center gap-2 text-gray-600">
                <Spinner size="sm" /> Loading…
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[64px]">#</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Qty (12m)</TableHead>
                    <TableHead className="text-right">Revenue (12m)</TableHead>
                    <TableHead className="text-right">Gross Profit (12m)</TableHead>
                    <TableHead className="text-right w-[140px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(items ?? []).map((p, i) => (
                    <TableRow key={p.id}>
                      <TableCell>{startRank + i + 1}</TableCell>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right">{Number(p.qty_12m || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {Number(p.revenue_12m || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(p.gross_profit_12m || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' })}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => navigate(`/products/${p.id}`)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}

                  {((items ?? []).length === 0 && !loading && !error) && (
                    <TableRow>
                      <TableCell colSpan={6}>
                        <Alert variant="warning">Not found</Alert>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
