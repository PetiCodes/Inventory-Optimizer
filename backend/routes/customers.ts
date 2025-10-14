// backend/routes/customers.ts
import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ------------------------------ Utilities ------------------------------ */
function toInt(v: any, d: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/* ------------------------------ List (paged + search) ------------------------------ */
/**
 * GET /api/customers?page=1&pageSize=15&q=...
 * Returns { items:[{id,name}], total, page, pageSize }
 */
router.get('/customers', async (req, res) => {
  try {
    const page = Math.max(1, toInt(req.query.page, 1))
    const pageSize = Math.min(100, Math.max(1, toInt(req.query.pageSize, 15)))
    const q = String(req.query.q ?? '').trim()
    const start = (page - 1) * pageSize
    const end = start + pageSize - 1

    let query = supabaseService
      .from('customers')
      .select('id,name', { count: 'exact' })
      .order('name', { ascending: true })
      .range(start, end)

    if (q) query = query.ilike('name', `%${q}%`)

    const { data, error, count } = await query
    if (error) return res.status(500).json({ error: error.message })

    res.json({ items: data ?? [], total: count ?? 0, page, pageSize })
  } catch (e: any) {
    console.error('GET /customers error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load customers' })
  }
})

/* ------------------------------ Basic detail ------------------------------ */
/**
 * GET /api/customers/:id
 * Returns {id,name}
 */
router.get('/customers/:id', async (req, res) => {
  try {
    const id = String(req.params.id)
    const { data, error } = await supabaseService
      .from('customers')
      .select('id,name')
      .eq('id', id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Not found' })
    res.json(data)
  } catch (e: any) {
    console.error('GET /customers/:id error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load customer' })
  }
})

/* ------------------------------ Overview for CustomerDetail page ------------------------------ */
/**
 * GET /api/customers/:id/overview
 * Returns:
 * {
 *   customer: { id, name },
 *   summary: { total_qty, distinct_products, first_date, last_date },
 *   products: [{ product_id, product_name, qty }]
 * }
 */
router.get('/customers/:id/overview', async (req, res) => {
  try {
    const id = String(req.params.id)

    // 1) header
    const c = await supabaseService.from('customers').select('id,name').eq('id', id).single()
    if (c.error || !c.data) return res.status(404).json({ error: 'Not found' })
    const customer = c.data

    // 2) summary
    const sum = await supabaseService
      .from('sales')
      .select('quantity, date, product_id', { count: 'exact', head: false })
      .eq('customer_id', id)

    if (sum.error) return res.status(500).json({ error: sum.error.message })

    let total_qty = 0
    let first_date: string | null = null
    let last_date: string | null = null
    const productSet = new Set<string>()

    for (const r of sum.data ?? []) {
      total_qty += Number(r.quantity || 0)
      if (r.product_id) productSet.add(String(r.product_id))
      const d = String(r.date)
      if (d) {
        if (!first_date || d < first_date) first_date = d
        if (!last_date || d > last_date) last_date = d
      }
    }

    const summary = {
      total_qty,
      distinct_products: productSet.size,
      first_date,
      last_date
    }

    // 3) products purchased (aggregate by product)
    const prod = await supabaseService
      .from('sales')
      .select('product_id, quantity, products(name)')
      .eq('customer_id', id)

    if (prod.error) return res.status(500).json({ error: prod.error.message })

    const byProd = new Map<string, { product_id: string; product_name: string; qty: number }>()
    for (const r of prod.data ?? []) {
      const pid = String(r.product_id)
      const name = (r as any).products?.name ?? 'Unknown'
      const prev = byProd.get(pid) || { product_id: pid, product_name: name, qty: 0 }
      prev.qty += Number(r.quantity || 0)
      byProd.set(pid, prev)
    }
    const products = Array.from(byProd.values()).sort((a, b) => b.qty - a.qty)

    res.json({ customer, summary, products })
  } catch (e: any) {
    console.error('GET /customers/:id/overview error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load overview' })
  }
})

/* ------------------------------ Monthly (last12 or specific year) ------------------------------ */
/**
 * GET /api/customers/:id/monthly?mode=last12  OR  ?mode=year&year=2024
 * Returns 12 data points with missing months as 0.
 */
router.get('/customers/:id/monthly', async (req, res) => {
  try {
    const customerId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : null

    let start: Date, end: Date, label: string
    const today = new Date()

    if (mode === 'year' && year && Number.isFinite(year)) {
      start = new Date(Date.UTC(year, 0, 1))
      end   = new Date(Date.UTC(year, 11, 31))
      label = String(year)
    } else {
      const endMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      const startMonth = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - 11, 1))
      start = startMonth
      end   = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 0))
      label = 'last12'
    }

    const startStr = start.toISOString().slice(0, 10)
    const endStr = end.toISOString().slice(0, 10)

    const { data, error } = await supabaseService
      .from('sales')
      .select('date, quantity')
      .eq('customer_id', customerId)
      .gte('date', startStr)
      .lte('date', endStr)

    if (error) return res.status(500).json({ error: error.message })

    const months: { key: string; label: string; total: number }[] = []
    const startYear = start.getUTCFullYear()
    const startMonth = start.getUTCMonth()
    const keyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`

    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(startYear, startMonth + i, 1))
      months.push({ key: keyOf(d), label: d.toISOString().slice(0, 7), total: 0 })
    }

    for (const row of (data ?? [])) {
      const d = new Date(String(row.date))
      const k = keyOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      const bucket = months.find(m => m.key === k)
      if (bucket) bucket.total += Number(row.quantity || 0)
    }

    res.json({
      mode,
      label,
      start: months[0]?.label,
      end: months[months.length - 1]?.label,
      points: months.map(m => ({ month: m.label, total_qty: m.total }))
    })
  } catch (e: any) {
    console.error('GET /customers/:id/monthly error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load monthly totals' })
  }
})

export default router
