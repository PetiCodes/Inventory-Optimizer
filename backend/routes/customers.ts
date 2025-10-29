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
 *   summary: {
 *     total_qty, distinct_products, first_date, last_date,
 *     total_revenue, total_gross_profit
 *   },
 *   products: [{ product_id, product_name, qty, revenue, gross_profit }]
 * }
 *
 * Notes:
 * - Revenue = Σ(unit_price_at_sale * qty)
 * - GP      = Σ((unit_price_at_sale - current_unit_cost) * qty)
 *   => computed as: revenue - (current_unit_cost * total_qty_for_that_product)
 */
router.get('/customers/:id/overview', async (req, res) => {
  try {
    const id = String(req.params.id)

    // 1) header
    const c = await supabaseService.from('customers').select('id,name').eq('id', id).single()
    if (c.error || !c.data) return res.status(404).json({ error: 'Not found' })
    const customer = c.data

    // 2) pull all sales rows for this customer (no DB aggregates)
    const salesQ = await supabaseService
      .from('sales')
      .select('product_id, quantity, unit_price, date, products(name)')
      .eq('customer_id', id)

    if (salesQ.error) return res.status(500).json({ error: salesQ.error.message })

    // First pass: accumulate per product qty & revenue; collect product ids and date bounds
    type Acc = {
      product_id: string
      product_name: string
      qty: number
      revenue: number
    }
    const byProd = new Map<string, Acc>()
    let total_qty = 0
    let total_revenue = 0
    let first_date: string | null = null
    let last_date: string | null = null
    const productIds = new Set<string>()

    for (const r of salesQ.data ?? []) {
      const pid = String((r as any).product_id)
      if (!pid) continue
      productIds.add(pid)

      const name = (r as any).products?.name ?? 'Unknown'
      const qty = Number((r as any).quantity || 0)
      const up  = Number((r as any).unit_price || 0)
      const revenue = qty * up

      const prev = byProd.get(pid) || { product_id: pid, product_name: name, qty: 0, revenue: 0 }
      prev.qty += qty
      prev.revenue += revenue
      byProd.set(pid, prev)

      total_qty += qty
      total_revenue += revenue

      const d = String((r as any).date || '')
      if (d) {
        if (!first_date || d < first_date) first_date = d
        if (!last_date || d > last_date) last_date = d
      }
    }

    // 3) fetch current unit cost for all involved products (0 if missing)
    const ids = Array.from(productIds)
    const costMap = new Map<string, number>()
    if (ids.length) {
      const costQ = await supabaseService
        .from('v_product_current_price')
        .select('product_id, unit_cost')
        .in('product_id', ids)

      if (costQ.error) return res.status(500).json({ error: costQ.error.message })
      for (const r of costQ.data ?? []) {
        costMap.set(String((r as any).product_id), Number((r as any).unit_cost ?? 0))
      }
    }

    // 4) compute GP per product = revenue - (current_unit_cost * qty)
    let total_gross_profit = 0
    const products = Array.from(byProd.values())
      .map(p => {
        const unit_cost_now = costMap.get(p.product_id) ?? 0
        const gp = p.revenue - unit_cost_now * p.qty
        total_gross_profit += gp
        return {
          product_id: p.product_id,
          product_name: p.product_name,
          qty: p.qty,
          revenue: p.revenue,
          gross_profit: gp,
        }
      })
      .sort((a, b) => b.qty - a.qty)

    const summary = {
      total_qty,
      distinct_products: products.length,
      first_date,
      last_date,
      total_revenue,
      total_gross_profit,
    }

    res.json({ customer, summary, products })
  } catch (e: any) {
    console.error('GET /customers/:id/overview error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load overview' })
  }
})

/* ------------------------------ Monthly (last12 or specific year) ------------------------------ */
router.get('/customers/:id/monthly', async (req, res) => {
  try {
    const customerId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : null

    let start: Date | undefined, end: Date | undefined, label: string
    const today = new Date()

    if (mode === 'allyears') {
      // For all years, first get the date range from all sales
      const allSalesQ = await supabaseService
        .from('sales')
        .select('date')
        .eq('customer_id', customerId)
        .order('date', { ascending: true })
      
      if (allSalesQ.error) return res.status(500).json({ error: allSalesQ.error.message })
      
      const allDates = (allSalesQ.data ?? []).map(r => new Date(String(r.date) + 'T00:00:00Z'))
      
      if (allDates.length === 0) {
        return res.json({
          mode: 'allyears',
          label: 'all years',
          start: null,
          end: null,
          points: []
        })
      }
      
      const firstDate = allDates[0]
      const lastDate = allDates[allDates.length - 1]
      
      start = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), 1))
      end = new Date(Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth() + 1, 0))
      label = 'all years'
    } else if (mode === 'year' && year && Number.isFinite(year)) {
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

    const startStr = start ? start.toISOString().slice(0, 10) : undefined
    const endStr = end ? end.toISOString().slice(0, 10) : undefined

    let salesQuery = supabaseService
      .from('sales')
      .select('date, quantity')
      .eq('customer_id', customerId)
    
    if (startStr) salesQuery = salesQuery.gte('date', startStr)
    if (endStr) salesQuery = salesQuery.lte('date', endStr)

    const { data, error } = await salesQuery

    if (error) return res.status(500).json({ error: error.message })

    const keyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const monthMap = new Map<string, number>()

    // Build month map from all sales
    for (const row of (data ?? [])) {
      const d = new Date(String(row.date) + 'T00:00:00Z')
      const k = keyOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      monthMap.set(k, (monthMap.get(k) || 0) + Number(row.quantity || 0))
    }

    // Create months array from start to end
    const months: { key: string; label: string; total: number }[] = []
    
    if (start && end) {
      let currentYear = start.getUTCFullYear()
      let currentMonth = start.getUTCMonth()
      const endYear = end.getUTCFullYear()
      const endMonth = end.getUTCMonth()

      while (currentYear < endYear || (currentYear === endYear && currentMonth <= endMonth)) {
        const d = new Date(Date.UTC(currentYear, currentMonth, 1))
        const k = keyOf(d)
        months.push({ 
          key: k, 
          label: d.toISOString().slice(0, 7), 
          total: monthMap.get(k) || 0 
        })
        
        currentMonth++
        if (currentMonth > 11) {
          currentMonth = 0
          currentYear++
        }
      }
    }

    res.json({
      mode,
      label,
      start: months[0]?.label || null,
      end: months[months.length - 1]?.label || null,
      points: months.map(m => ({ month: m.label, total_qty: m.total }))
    })
  } catch (e: any) {
    console.error('GET /customers/:id/monthly error:', e)
    res.status(500).json({ error: e?.message || 'Failed to load monthly totals' })
  }
})

export default router
