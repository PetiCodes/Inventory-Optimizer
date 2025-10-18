import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* -------------------- date helpers (UTC, month-aligned) -------------------- */
function monthStartUTC(y: number, m0: number) { return new Date(Date.UTC(y, m0, 1)) }
function monthEndUTC(y: number, m0: number) { return new Date(Date.UTC(y, m0 + 1, 0)) }
function ymKeyUTC(d: Date): string { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` }
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

/* --------------------------- PRODUCT OVERVIEW --------------------------- */
/**
 * GET /api/products/:id/overview
 *  Query:
 *    mode=last12 | year
 *    year=YYYY   (required if mode=year)
 *    top=1..5    (kept for backward compatibility; we now also return allCustomers)
 */
router.get('/products/:id/overview', async (req, res) => {
  try {
    const productId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : undefined
    const top = Math.max(1, Math.min(Number(req.query.top ?? 5), 5))

    // Product header
    const prod = await supabaseService.from('products').select('id,name').eq('id', productId).single()
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

    // 2) Costs up to end of range (to compute GP using cost at/ before sale date)
    const pricesQ = await supabaseService
      .from('product_prices')
      .select('effective_date, unit_cost')
      .eq('product_id', productId)
      .lte('effective_date', rangeEndISO)
      .order('effective_date', { ascending: true })
    if (pricesQ.error) return res.status(500).json({ error: pricesQ.error.message })
    const pricePoints = (pricesQ.data ?? []).map(p => ({ eff: String(p.effective_date), cost: Number(p.unit_cost ?? 0) }))

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

    // 3) Build monthly qty series for chart
    const monthMap = new Map<string, number>()
    for (const s of sales) {
      const d = new Date(s.date + 'T00:00:00Z')
      const key = ymKeyUTC(monthStartUTC(d.getUTCFullYear(), d.getUTCMonth()))
      monthMap.set(key, (monthMap.get(key) || 0) + s.qty)
    }
    const monthly = scaffold.map(s => ({ month: `${s.key}-01`, qty: monthMap.get(s.key) ?? 0 }))

    // 4) stats12
    const s12Scaffold = lastNMonthsScaffold(12)
    const s12StartISO = monthStartUTC(s12Scaffold[0].y, s12Scaffold[0].m0).toISOString().slice(0, 10)
    const s12EndISO = monthEndUTC(s12Scaffold[s12Scaffold.length - 1].y, s12Scaffold[s12Scaffold.length - 1].m0)
      .toISOString().slice(0, 10)
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

    // 6) Seasonality & legacy “top” customers (still returned)
    const seas = await supabaseService.rpc('product_seasonality_last12', { p_product_id: productId })
    if (seas.error) return res.status(500).json({ error: seas.error.message })
    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    // 7) NEW: All customers for this product in the selected window (quantity aggregated)
    const aggQ = await supabaseService
      .from('sales')
      .select('customer_id, qty:sum(quantity)')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)
      .group('customer_id')
      .order('qty', { ascending: false })
    if (aggQ.error) return res.status(500).json({ error: aggQ.error.message })
    const allCustIds = (aggQ.data ?? []).map((r: any) => String(r.customer_id))
    let nameMap = new Map<string, string>()
    if (allCustIds.length) {
      const nQ = await supabaseService.from('customers').select('id,name').in('id', allCustIds)
      if (nQ.error) return res.status(500).json({ error: nQ.error.message })
      for (const c of nQ.data ?? []) nameMap.set(String(c.id), String(c.name ?? ''))
    }
    const allCustomers = (aggQ.data ?? []).map((r: any) => ({
      customer_id: String(r.customer_id),
      customer_name: (nameMap.get(String(r.customer_id)) || '').trim() || '(unknown customer)',
      qty: Number(r.qty ?? 0)
    }))

    return res.json({
      product: prod.data,
      monthly,
      seasonality: (seas.data ?? []).map((r: any) => ({ month_num: r.month_num, avg_qty: Number(r.avg_qty) || 0 })),
      topCustomers: (topRes.data ?? []).map((r: any) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        qty: Number(r.qty) || 0
      })),
      allCustomers, // <- NEW full list for the window
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
