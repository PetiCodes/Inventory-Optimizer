import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ------------------------------ Utilities ------------------------------ */
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function monthEndUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0))
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

/* ----------------------- PAGINATED PRODUCTS LIST ----------------------- */
router.get('/products/list', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1))
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 200))
    const gpOrder = String(req.query.gp_order ?? 'none') // 'none' | 'asc' | 'desc'
    const ohOrder = String(req.query.oh_order ?? 'none') // 'none' | 'asc' | 'desc'
    const q = String(req.query.q ?? '').trim()

    const from = (page - 1) * limit
    const to = from + limit - 1

    // INVENTORY-DRIVEN branch: sort by on_hand using the SQL view (no client stitching)
    if (ohOrder !== 'none') {
      const ohAsc = ohOrder === 'asc'
      const gpAsc = gpOrder === 'asc'

      let viewQ = supabaseService
        .from('v_products_onhand')
        .select('product_id, product_name, on_hand, qty_12m, revenue_12m, gross_profit_12m', { count: 'exact' })

      if (q) viewQ = viewQ.ilike('product_name', `%${q}%`)

      // Primary sort: if gpOrder requested, apply it first; then on_hand as secondary.
      if (gpOrder !== 'none') {
        viewQ = viewQ.order('gross_profit_12m', { ascending: gpAsc, nullsFirst: gpAsc })
      }
      viewQ = viewQ.order('on_hand', { ascending: ohAsc, nullsFirst: ohAsc })

      viewQ = viewQ.range(from, to)

      const { data, error, count } = await viewQ
      if (error) return res.status(500).json({ error: error.message })

      const items = (data ?? []).map(r => ({
        id: String(r.product_id),
        name: (r.product_name || '').trim() || '(unknown product)',
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0),
        on_hand: Number(r.on_hand ?? 0),
      }))

      return res.json({
        page,
        limit,
        total: count ?? items.length,
        pages: Math.max(1, Math.ceil((count ?? items.length) / limit)),
        items,
      })
    }

    // GP-driven/default branch (kept as your original, DB-side join via view)
    let builder = supabaseService
      .from('v_product_profit_cache')
      .select(`
        product_id, 
        product_name, 
        qty_12m, 
        revenue_12m, 
        gross_profit_12m,
        inventory_current(on_hand)
      `, { count: 'exact' })

    if (q) builder = builder.ilike('product_name', `%${q}%`)

    if (gpOrder !== 'none') {
      const gpAsc = gpOrder === 'asc'
      builder = builder.order('gross_profit_12m', { ascending: gpAsc })
    } else {
      builder = builder.order('product_name', { ascending: true })
    }

    builder = builder.range(from, to)

    const viewRes = await builder
    if (viewRes.error) return res.status(500).json({ error: viewRes.error.message })

    const total = viewRes.count ?? (viewRes.data?.length ?? 0)
    const items = (viewRes.data ?? []).map((r: any) => ({
      id: String(r.product_id),
      name: String(r.product_name ?? '').trim() || '(unknown product)',
      qty_12m: Number(r.qty_12m ?? 0),
      revenue_12m: Number(r.revenue_12m ?? 0),
      gross_profit_12m: Number(r.gross_profit_12m ?? 0),
      on_hand: Number(r.inventory_current?.on_hand ?? 0),
    }))

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items,
    })
  } catch (e: any) {
    console.error('GET /products/list error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/* --------------------------- PRODUCT OVERVIEW --------------------------- */
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

    // Time window
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

    // Sales for the window
    const salesQ = await supabaseService
      .from('sales')
      .select('date, quantity, unit_price, customer_id')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)
      .order('date', { ascending: true })

    if (salesQ.error) return res.status(500).json({ error: salesQ.error.message })
    const sales = (salesQ.data ?? []).map(r => ({
      date: String(r.date),
      qty: Number(r.quantity ?? 0),
      unit_price: Number(r.unit_price ?? 0),
      customer_id: String(r.customer_id),
    }))

    // Totals in the window
    let totalQty = 0
    let totalRevenue = 0
    for (const s of sales) {
      totalQty += s.qty
      totalRevenue += s.qty * s.unit_price
    }
    const aspWeighted = totalQty > 0 ? totalRevenue / totalQty : 0

    // Current unit cost/price
    const priceNow = await supabaseService
      .from('v_product_current_price')
      .select('unit_cost, unit_price, effective_date')
      .eq('product_id', productId)
      .maybeSingle()
    const unit_cost_now = Number(priceNow.data?.unit_cost ?? 0)
    const unit_price_now = Number(priceNow.data?.unit_price ?? 0)

    // GP by requested formula
    const gross_profit = (aspWeighted - unit_cost_now) * totalQty

    // Monthly series (qty)
    const monthMap = new Map<string, number>()
    for (const s of sales) {
      const d = new Date(s.date + 'T00:00:00Z')
      const key = ymKeyUTC(monthStartUTC(d.getUTCFullYear(), d.getUTCMonth()))
      monthMap.set(key, (monthMap.get(key) || 0) + s.qty)
    }
    const monthly = scaffold.map(s => ({
      month: `${s.key}-01`,
      qty: monthMap.get(s.key) ?? 0,
    }))

    // stats12
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

    // Inventory now
    const inv = await supabaseService
      .from('inventory_current')
      .select('on_hand, backorder')
      .eq('product_id', productId)
      .maybeSingle()

    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)

    // Seasonality & top customers
    const seas = await supabaseService.rpc('product_seasonality_last12', { p_product_id: productId })
    if (seas.error) return res.status(500).json({ error: seas.error.message })

    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    // All customers in the selected window (aggregate qty in Node)
    const salesCust = await supabaseService
      .from('sales')
      .select('customer_id, quantity')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)

    if (salesCust.error) {
      return res.status(500).json({ error: salesCust.error.message })
    }

    const qtyByCustomer = new Map<string, number>()
    for (const r of salesCust.data ?? []) {
      const cid = String((r as any).customer_id)
      const q = Number((r as any).quantity ?? 0)
      qtyByCustomer.set(cid, (qtyByCustomer.get(cid) || 0) + q)
    }

    const allIds = Array.from(qtyByCustomer.keys())
    let nameMap = new Map<string, string>()
    if (allIds.length) {
      const names = await supabaseService.from('customers').select('id,name').in('id', allIds)
      if (names.error) return res.status(500).json({ error: names.error.message })
      for (const c of names.data ?? []) nameMap.set(String(c.id), String(c.name ?? ''))
    }

    const customersAll = allIds
      .map((cid) => ({
        customer_id: cid,
        customer_name: (nameMap.get(cid) || '').trim() || '(unknown customer)',
        qty: qtyByCustomer.get(cid) ?? 0,
      }))
      .sort((a, b) => b.qty - a.qty)

    return res.json({
      product: prod.data,
      monthly,
      seasonality: (seas.data ?? []).map((r: any) => ({ month_num: r.month_num, avg_qty: Number(r.avg_qty) || 0 })),
      topCustomers: (topRes.data ?? []).map((r: any) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        qty: Number(r.qty) || 0,
      })),
      customers: customersAll,
      pricing: {
        average_selling_price: aspWeighted,
        current_unit_cost: unit_cost_now,
        current_unit_price: unit_price_now,
      },
      profit_window: {
        mode,
        year: mode === 'year' ? year : undefined,
        total_qty: totalQty,
        total_revenue: totalRevenue,
        unit_cost_used: unit_cost_now,
        gross_profit, // (ASP - current cost) * qty
      },
      stats12: {
        weighted_avg_12m: weightedAvg12,
        sigma_12m: sigma12,
        weighted_moq,
      },
      inventory: { on_hand, backorder },
    })
  } catch (e: any) {
    console.error('GET /products/:id/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
