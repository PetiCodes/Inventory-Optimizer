import React, { useEffect, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Input from '../components/ui/Input'
import Table, { TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

type Product = { id: string; name: string }

export default function Products() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [typing, setTyping] = useState('')
  const [items, setItems] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setQ(typing.trim()), 300)
    return () => clearTimeout(t)
  }, [typing])

  useEffect(() => { search() }, [q])

  async function search() {
    setLoading(true)
    setError(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const params = new URLSearchParams()
      params.set('limit', '50')
      if (q) params.set('q', q)
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/products/search?` + params.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      setItems(json.results ?? [])
    } catch (e: any) {
      setError(e.message || 'Failed to search products')
      setItems([])
    } finally {
      setLoading(false)
    }
  }

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
        </div>

        <Card>
          <CardHeader>
            <div className="text-sm text-gray-600">
              {loading ? 'Searching…' : `Found ${items.length} items`}
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
                  {(items ?? []).map((p, i) => (
                    <TableRow key={p.id}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => navigate(`/products/${p.id}`)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {((items ?? []).length === 0 && !loading && !error) && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-gray-500">
                        No products found.
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
