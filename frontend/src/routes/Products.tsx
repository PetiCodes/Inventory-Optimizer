import React, { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader } from '../components/ui/Card'
import Input from '../components/ui/Input'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { supabase } from '../lib/supabaseClient'
import { useNavigate } from 'react-router-dom'

type Product = { id: string; name: string }

export default function Products() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const navigate = useNavigate()

  // simple debounce
  const debouncedQuery = useMemo(() => {
    const controller = new AbortController()
    const id = setTimeout(async () => {
      try {
        setLoading(true)
        const token = (await supabase.auth.getSession()).data.session?.access_token
        if (!token) throw new Error('Not authenticated')

        const params = new URLSearchParams()
        if (query.trim()) params.set('q', query.trim())
        params.set('limit', '20')

        const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/products/search?` + params.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
        setResults(data.results || [])
        setErr(null)
      } catch (e: any) {
        if (e.name !== 'AbortError') setErr(e.message || 'Failed to search')
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => { clearTimeout(id); controller.abort() }
  }, [query])

  useEffect(() => {
    // initial load (top alphabetically)
    setQuery('')
    // trigger search
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {}
  }, [])

  useEffect(() => {
    const cancel = (debouncedQuery as unknown as () => void)
    return cancel
  }, [debouncedQuery])

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-gray-600">Search a product and open its analytics page.</p>
        </div>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-gray-900">Search</h3>
          </CardHeader>
          <CardContent>
            <Input
              label="Product name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Start typing…"
            />
            {loading && (
              <div className="mt-3 flex items-center space-x-2">
                <Spinner size="sm" />
                <span className="text-gray-600">Searching…</span>
              </div>
            )}
            {err && <div className="mt-3"><Alert variant="error">{err}</Alert></div>}

            <div className="mt-4 space-y-2">
              {results.map((p) => (
                <div key={p.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                  <div className="font-medium text-gray-900">{p.name}</div>
                  <Button size="sm" onClick={() => navigate(`/products/${p.id}`)}>Open</Button>
                </div>
              ))}
              {!loading && results.length === 0 && (
                <div className="text-gray-500 text-sm">No products found.</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
