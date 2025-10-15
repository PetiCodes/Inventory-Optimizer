import React, { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardHeader, CardContent } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

type Customer = { id: string; name: string }
type ApiList = { items: Customer[]; total: number; page: number; pageSize: number }

export default function Customers() {
  const navigate = useNavigate()

  const [page, setPage] = useState(1)
  const pageSize = 15
  const [q, setQ] = useState('')
  const [typing, setTyping] = useState('')

  const [items, setItems] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // debounce search input
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(typing.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [typing])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('pageSize', String(pageSize))
      if (q) params.set('q', q)

      const token = (await supabase.auth.getSession()).data.session?.access_token
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/customers?` + params.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      const json: Partial<ApiList> = await res.json()
      if (!res.ok) throw new Error((json as any)?.error || `HTTP ${res.status}`)

      setItems(Array.isArray(json.items) ? json.items : [])
      setTotal(typeof json.total === 'number' ? json.total : 0)
    } catch (e: any) {
      setError(e.message || 'Failed to load customers')
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [page, q])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total])
  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
          <div className="md:ml-auto w-full md:w-96">
            <Input
              label="Search customers"
              placeholder="Type a name…"
              value={typing}
              onChange={e => setTyping(e.target.value)}
            />
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600">
                {loading ? 'Loading…' : `Showing ${items.length} of ${total} customers`}
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
                    <TableHead className="text-right w-[140px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(items ?? []).map((c, i) => (
                    <TableRow key={c.id}>
                      <TableCell>{(page - 1) * pageSize + i + 1}</TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          onClick={() => navigate(`/customers/${c.id}`)}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}

                  {(items ?? []).length === 0 && !loading && !error && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-gray-500">
                        No customers found.
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
