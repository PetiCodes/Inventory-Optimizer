import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* -------------------- date helpers (UTC, month-aligned) -------------------- */
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function monthEndUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0)) // day 0 of next month == last day of this month
}
function ymKeyUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function lastNMonthsScaffold(n: number) {
  const now = new Date()
  const anchorStart = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: { key: string; y: number; m0: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = monthStartUTC(anchorStart.getUTCFullYear(), anchorStart.getUTCMonth() - i)
    out.push({ key: ymKeyUTC(d), y: d.getUTCFullYear(), m0: d.getUTCMonth() })
  }
  return out
}
function scaffoldYearUTC(year: number) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = monthStartUTC(year, i)
    return { key: ymKeyUTC(d), y: d.getUTCFullYear(), m0: d.getUTCMonth() }
  })
}
function stddev(nums: number[]): number {
  if (!nums.length) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const v = nums.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / nums.length
  return Math.sqrt(v)
}
const ORDER_COVERAGE_MONTHS = 4

/* ------------------------------ SIMPLE SEARCH ------------------------------ */
/**
 * GET /api/products/search?q=...&limit=20
 * (Kept for compatibility; not used by the new Products page list.)
 */
router.get('/products/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50), 200))
    let query = supabaseService
      .from('products')
      .select('id,name')
      .order('name', { ascending: true })
      .limit(limit)

    if (q) query = query.ilike('name', `%${q}%`)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ results: data ?? [] })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/* ----------------------- PAGINATED GP-RANKED LIST ----------------------- */
/**
 * GET /api/products/list
 * Query:
 *   page=1 (1-based)
 *   limit=20
 *   q=search string (matches product name)
 *   order=gp_desc | gp_asc   (default gp_desc)
 *
 * Returns rows ranked by 12m Gross Profit from v_product_profit_cache (preferred)
 * or falls back to product_profit_cache + names.
 */
router.get('/products/list', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 200))
    const orderParam = String(req.query.order ?? 'gp_desc')
    const ascending = orderParam === 'gp_asc'
    const q = String(req.query.q ?? '').trim()

    const from = (page - 1) * limit
    const to = from + limit - 1

    // Try the convenience view first (already includes product_name)
    let view = await supabaseService
      .from('v_product_profit_cache')
      .select('product_id,product_name,qty_12m,revenue_12m,gross_profit_12m', { count: 'exact' })

    if (q) view = view.ilike('product_name', `%${q}%`)
    view = view.order('gross_profit_12m', { ascending })
    view = view.range(from, to)

    const viewRes = await view

    if (!viewRes.error) {
      const total = viewRes.count ?? (viewRes.data?.length ?? 0)
      const items = (viewRes.data ?? []).map((r: any) => ({
        id: String(r.product_id),
        name: String(r.product_name ?? '').trim() || '(unknown product)',
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0)
      }))
      return res.json({
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
        items
      })
    }

    // ---- Fallback: product_profit_cache + names from products ----
    // Step 1: filter by q using product name -> ids (if q provided)
    let idFilter: string[] | null = null
    if (q) {
      const nameRes = await supabaseService
        .from('products')
        .select('id,name')
        .ilike('name', `%${q}%`)
      if (nameRes.error) return res.status(500).json({ error: nameRes.error.message })
      idFilter = (nameRes.data ?? []).map(r => String(r.id))
      if (idFilter.length === 0) {
        return res.json({ page, limit, total: 0, pages: 1, items: [] })
      }
    }

    let cacheQ = supabaseService
      .from('product_profit_cache')
      .select('product_id,qty_12m,revenue_12m,gross_profit_12m', { count: 'exact' })

    if (idFilter) cacheQ = cacheQ.in('product_id', idFilter)
    cacheQ = cacheQ.order('gross_profit_12m', { ascending }).range(from, to)

    const cacheRes = await cacheQ
    if (cacheRes.error) return res.status(500).json({ error: cacheRes.error.message })

    const ids = (cacheRes.data ?? []).map(r => String(r.product_id))
    let names = new Map<string, string>()
    if (ids.length) {
      const namesRes = await supabaseService.from('products').select('id,name').in('id', ids)
      if (namesRes.error) return res.status(500).json({ error: namesRes.error.message })
      for (const p of namesRes.data ?? []) names.set(String(p.id), String(p.name ?? ''))
    }

    const total = cacheRes.count ?? (cacheRes.data?.length ?? 0)
    const items = (cacheRes.data ?? []).map((r: any) => ({
      id: String(r.product_id),
      name: (names.get(String(r.product_id)) || '').trim() || '(unknown product)',
      qty_12m: Number(r.qty_12m ?? 0),
      revenue_12m: Number(r.revenue_12m ?? 0),
      gross_profit_12m: Number(r.gross_profit_12m ?? 0)
    }))

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items
    })
  } catch (e: any) {
    console.error('GET /products/list error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/* --------------------------- PRODUCT OVERVIEW --------------------------- */
/**
 * GET /api/products/:id/overview
 *  Query:
 *    mode=last12 | year
 *    year=YYYY   (required if mode=year)
 *    top=1..5
 */
router.get('/products/:id/overview', async (req, res) => {
  try {
    const productId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : undefined
    const top = Math.max(1, Math.min(Number(req.query.top ?? 5), 5))

    // Product header
    const prod = await supabaseService
      .from('products')
      .select('id,name')
      .eq('id', productId)
      .single()
    if (prod.error || !prod.data) return res.status(404).json({ error: 'Product not found' })

    // Build the time window + X-axis scaffold for the chart
    let scaffold: { key: string; y: number; m0: number }[]
    let rangeStartISO: string
    let rangeEndISO: string

    if (mode === 'year' && year && Number.isFinite(year)) {
      scaffold = scaffoldYearUTC(year)
      rangeStartISO = `${year}-01-01`
      rangeEndISO = `${year}-12-31`
    } else {
      scaffold = lastNMonthsScaffold(12)
      const first = scaffold[0]
      const last = scaffold[scaffold.length - 1]
      rangeStartISO = monthStartUTC(first.y, first.m0).toISOString().slice(0, 10)
      rangeEndISO = monthEndUTC(last.y, last.m0).toISOString().slice(0, 10)
    }

    // 1) Pull sales within the chosen range
    const salesQ = await supabaseService
      .from('sales')
      .select('date, quantity, unit_price')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)
      .order('date', { ascending: true })

    if (salesQ.error) return res.status(500).json({ error: salesQ.error.message })
    const sales = (salesQ.data ?? []).map(r => ({
      date: String(r.date),
      qty: Number(r.quantity ?? 0),
      unit_price: Number(r.unit_price ?? 0)
    }))

    // 2) Pull all price records up to the end of range, then scan to find cost-at-sale-date
    const pricesQ = await supabaseService
      .from('product_prices')
      .select('effective_date, unit_cost')
      .eq('product_id', productId)
      .lte('effective_date', rangeEndISO)
      .order('effective_date', { ascending: true })

    if (pricesQ.error) return res.status(500).json({ error: pricesQ.error.message })
    const pricePoints = (pricesQ.data ?? []).map(p => ({
      eff: String(p.effective_date),
      cost: Number(p.unit_cost ?? 0)
    }))

    // Use latest cost with effective_date <= sale.date; if none, use 0.
    let pi = -1
    let currentCost = 0
    const gpAccumulator = { qty: 0, revenue: 0, cost: 0 }

    for (const s of sales) {
      while (pi + 1 < pricePoints.length && pricePoints[pi + 1].eff <= s.date) {
        pi++
        currentCost = pricePoints[pi].cost
      }
      const revenue = s.unit_price * s.qty
      const cost = currentCost * s.qty

      gpAccumulator.qty += s.qty
      gpAccumulator.revenue += revenue
      gpAccumulator.cost += cost
    }

    const gross_profit = gpAccumulator.revenue - gpAccumulator.cost
    const aspWeighted = gpAccumulator.qty > 0 ? gpAccumulator.revenue / gpAccumulator.qty : 0

    // 3) Build monthly series (qty) for the chart from the same sales set
    const monthMap = new Map<string, number>()
    for (const s of sales) {
      const d = new Date(s.date + 'T00:00:00Z')
      const key = ymKeyUTC(monthStartUTC(d.getUTCFullYear(), d.getUTCMonth()))
      monthMap.set(key, (monthMap.get(key) || 0) + s.qty)
    }
    const monthly = scaffold.map(s => ({
      month: `${s.key}-01`,
      qty: monthMap.get(s.key) ?? 0
    }))

    // 4) stats12: ALWAYS last 12 months ending this month
    const s12Scaffold = lastNMonthsScaffold(12)
    const s12StartISO = monthStartUTC(s12Scaffold[0].y, s12Scaffold[0].m0).toISOString().slice(0, 10)
    const s12EndISO = monthEndUTC(
      s12Scaffold[s12Scaffold.length - 1].y,
      s12Scaffold[s12Scaffold.length - 1].m0
    ).toISOString().slice(0, 10)

    const s12Q = await supabaseService
      .from('sales')
      .select('date, quantity')
      .eq('product_id', productId)
      .gte('date', s12StartISO)
      .lte('date', s12EndISO)

    if (s12Q.error) return res.status(500).json({ error: s12Q.error.message })
    const buckets12 = s12Scaffold.map(s => ({ key: s.key, qty: 0 }))
    for (const r of s12Q.data ?? []) {
      const d = new Date(String(r.date) + 'T00:00:00Z')
      const key = ymKeyUTC(monthStartUTC(d.getUTCFullYear(), d.getUTCMonth()))
      const b = buckets12.find(x => x.key === key)
      if (b) b.qty += Number(r.quantity ?? 0)
    }
    const weights = buckets12.map((_, i) => i + 1)
    const wSum = weights.reduce((a, b) => a + b, 0)
    const weightedSum = buckets12.reduce((acc, r, i) => acc + r.qty * weights[i], 0)
    const weightedAvg12 = wSum ? weightedSum / wSum : 0
    const sigma12 = stddev(buckets12.map(r => r.qty))
    const weighted_moq = Math.ceil(weightedAvg12 * ORDER_COVERAGE_MONTHS)

    // 5) Inventory & current price (info only)
    const inv = await supabaseService
      .from('inventory_current')
      .select('on_hand, backorder')
      .eq('product_id', productId)
      .maybeSingle()

    const priceNow = await supabaseService
      .from('v_product_current_price')
      .select('unit_cost, unit_price, effective_date')
      .eq('product_id', productId)
      .maybeSingle()

    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)
    const unit_cost_now = Number(priceNow.data?.unit_cost ?? 0)
    const unit_price_now = Number(priceNow.data?.unit_price ?? 0)

    // 6) Seasonality & top customers
    const seas = await supabaseService.rpc('product_seasonality_last12', { p_product_id: productId })
    if (seas.error) return res.status(500).json({ error: seas.error.message })

    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    return res.json({
      product: prod.data,
      monthly,
      seasonality: (seas.data ?? []).map((r: any) => ({ month_num: r.month_num, avg_qty: Number(r.avg_qty) || 0 })),
      topCustomers: (topRes.data ?? []).map((r: any) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        qty: Number(r.qty) || 0
      })),
      pricing: {
        average_selling_price: aspWeighted,
        current_unit_cost: unit_cost_now,
        current_unit_price: unit_price_now
      },
      profit_window: {
        mode,
        year: mode === 'year' ? year : undefined,
        total_qty: gpAccumulator.qty,
        total_revenue: gpAccumulator.revenue,
        unit_cost_used: undefined, // per-sale historical costs
        gross_profit
      },
      stats12: {
        weighted_avg_12m: weightedAvg12,
        sigma_12m: sigma12,
        weighted_moq
      },
      inventory: { on_hand, backorder }
    })
  } catch (e: any) {
    console.error('GET /products/:id/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
