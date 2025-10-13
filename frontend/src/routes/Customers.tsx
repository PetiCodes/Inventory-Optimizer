import React, { useEffect, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import Input from '../components/ui/Input'
import { supabase } from '../lib/supabaseClient'
import { useNavigate } from 'react-router-dom'

type Customer = { id: string; name: string }
type ApiResponse = { page: number; pageSize: number; total: number; customers: Customer[] }

const PAGE_SIZE = 15

export default function Customers() {
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [rows, setRows] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  async function fetchCustomers() {
    setLoading(true)
    setErr(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (query.trim()) params.append('q', query.trim())

      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/customers?` + params.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data: ApiResponse = await res.json()
      if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`)
      setRows(data.customers)
      setTotal(data.total)
    } catch (e: any) {
      setErr(e.message || 'Failed to load customers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchCustomers()
  }, [page])

  const prevDisabled = page <= 1
  const nextDisabled = page >= totalPages

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header + Search */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
            <p className="text-gray-600">Search or browse customers ({PAGE_SIZE} per page)</p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search customer..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{ width: '220px' }}
            />
            <Button onClick={() => { setPage(1); fetchCustomers() }}>Search</Button>
          </div>
        </div>

        {/* Pagination Controls */}
        <div className="flex justify-end items-center gap-2">
          <Button variant="secondary" onClick={() => setPage(1)} disabled={prevDisabled}>« First</Button>
          <Button variant="secondary" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={prevDisabled}>‹ Prev</Button>
          <span className="text-sm text-gray-700 px-2">
            Page <span className="font-semibold">{page}</span> of <span className="font-semibold">{totalPages}</span>
          </span>
          <Button variant="secondary" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={nextDisabled}>Next ›</Button>
          <Button variant="secondary" onClick={() => setPage(totalPages)} disabled={nextDisabled}>Last »</Button>
        </div>

        {loading && (
          <div className="flex items-center space-x-2">
            <Spinner size="sm" />
            <span className="text-gray-600">Loading…</span>
          </div>
        )}
        {err && <Alert variant="error">{err}</Alert>}

        {!loading && !err && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-gray-900">All Customers</h3>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">#</TableHead>
                    <TableHead>Customer Name</TableHead>
                    <TableHead className="text-right w-[140px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((c, idx) => (
                    <TableRow key={c.id}>
                      <TableCell>{(page - 1) * PAGE_SIZE + idx + 1}</TableCell>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => navigate(`/customers/${c.id}`)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-gray-500">
                        No customers found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  )
}
