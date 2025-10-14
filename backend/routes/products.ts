import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware.js'
import { supabaseService } from '../src/supabase.js'

const router = Router()

// ---- helpers ----
function ymUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function lastNMonthsUTC(n: number): { key: string; y: number; m0: number }[] {
  const now = new Date()
  const anchor = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: { key: string; y: number; m0: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = monthStartUTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i)
    out.push({ key: ymUTC(d), y: d.getUTCFullYear(), m0: d.getUTCMonth() })
  }
  return out
}
function scaffoldYearUTC(year: number): { key: string; y: number; m0: number }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const d = monthStartUTC(year, i)
    return { key: ymUTC(d), y: d.getUTCFullYear(), m0: d.getUTCMonth() }
  })
}
function stddev(nums: number[]): number {
  if (!nums.length) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const v = nums.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / nums.length
  return Math.sqrt(v)
}
const ORDER_COVERAGE_MONTHS = 4

/**
 * GET /api/products/search?q=...&limit=20
 */
router.get('/products/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 100))
    let query = supabaseService.from('products').select('id,name').order('name', { ascending: true }).limit(limit)
    if (q) query = query.ilike('name', `%${q}%`)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ results: data ?? [] })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/**
 * GET /api/products/:id/overview
 * Query:
 *   mode=last12 | year
 *   year=YYYY   (required if mode=year)
 *   top=1..5    (top customers)
 *
 * Response monthly series follows mode.
 * stats12 (weighted avg, sigma, weighted_moq) always computed on the *last 12 months* ending now.
 */
router.get('/products/:id/overview', async (req, res) => {
  try {
    const productId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : undefined
    const top = Math.max(1, Math.min(Number(req.query.top ?? 5), 5))

    const prod = await supabaseService.from('products').select('id,name').eq('id', productId).single()
    if (prod.error || !prod.data) return res.status(404).json({ error: 'Product not found' })

    /* ---------- Build MONTHLY (chart) depending on mode ---------- */
    let scaffoldForChart: { key: string; y: number; m0: number }[]
    let rangeStartISO: string
    let rangeEndISO: string

    if (mode === 'year' && year && Number.isFinite(year)) {
      scaffoldForChart = scaffoldYearUTC(year)
      rangeStartISO = `${year}-01-01`
      rangeEndISO = `${year}-12-31`
    } else {
      scaffoldForChart = lastNMonthsUTC(12)
      const first = scaffoldForChart[0]
      const last = scaffoldForChart[scaffoldForChart.length - 1]
      rangeStartISO = `${first.key}-01`
      // end of last month (UTC)
      const lastEnd = new Date(Date.UTC(last.y, last.m0 + 1, 0))
      rangeEndISO = lastEnd.toISOString().slice(0, 10)
    }

    // Pull sales in the chosen range (for chart)
    const salesForChart = await supabaseService
      .from('sales')
      .select('date, quantity, unit_price')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)

    if (salesForChart.error) return res.status(500).json({ error: salesForChart.error.message })

    const monthMap = new Map<string, number>()
    for (const r of salesForChart.data ?? []) {
      const d = new Date(String(r.date))
      const key = ymUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      monthMap.set(key, (monthMap.get(key) || 0) + Number(r.quantity || 0))
    }
    const monthly = scaffoldForChart.map(s => ({
      month: `${s.key}-01`,
      qty: monthMap.get(s.key) ?? 0
    }))

    /* ---------- stats12 (ALWAYS last 12 months ending this month) ---------- */
    const last12Scaffold = lastNMonthsUTC(12)
    const last12StartISO = `${last12Scaffold[0].key}-01`
    const last12EndISO = (() => {
      const t = last12Scaffold[last12Scaffold.length - 1]
      const end = new Date(Date.UTC(t.y, t.m0 + 1, 0))
      return end.toISOString().slice(0, 10)
    })()

    const sales12 = await supabaseService
      .from('sales')
      .select('date, quantity, unit_price')
      .eq('product_id', productId)
      .gte('date', last12StartISO)
      .lte('date', last12EndISO)

    if (sales12.error) return res.status(500).json({ error: sales12.error.message })

    const m12 = last12Scaffold.map(s => ({ key: s.key, qty: 0 }))
    for (const r of sales12.data ?? []) {
      const d = new Date(String(r.date))
      const key = ymUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      const bucket = m12.find(b => b.key === key)
      if (bucket) bucket.qty += Number(r.quantity || 0)
    }
    const weights = m12.map((_, i) => i + 1) // 1..12, recent has 12
    const wSum = weights.reduce((a, b) => a + b, 0)
    const weightedSum = m12.reduce((acc, r, i) => acc + r.qty * weights[i], 0)
    const weightedAvg12 = wSum ? weightedSum / wSum : 0
    const sigma12 = stddev(m12.map(r => r.qty))
    const weighted_moq = Math.ceil(weightedAvg12 * ORDER_COVERAGE_MONTHS)

    /* ---------- Inventory & current price/cost ---------- */
    const inv = await supabaseService
      .from('inventory_current')
      .select('on_hand,backorder')
      .eq('product_id', productId)
      .maybeSingle()

    const price = await supabaseService
      .from('v_product_current_price')
      .select('unit_cost,unit_price,effective_date')
      .eq('product_id', productId)
      .maybeSingle()

    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)
    const unit_cost_now = Number(price.data?.unit_cost ?? 0)
    const unit_price_now = Number(price.data?.unit_price ?? 0)

    /* ---------- ASP in the chart range (qty-weighted) with fallback ---------- */
    const qtyRevenue = (salesForChart.data ?? []).reduce(
      (acc, r: any) => {
        acc.qty += Number(r.quantity ?? 0)
        acc.rev += Number(r.unit_price ?? 0) * Number(r.quantity ?? 0)
        return acc
      },
      { qty: 0, rev: 0 }
    )
    const asp = qtyRevenue.qty > 0 && qtyRevenue.rev > 0 ? qtyRevenue.rev / qtyRevenue.qty : unit_price_now

    /* ---------- Profit window over the chart range ---------- */
    // You can keep your RPC if it expects months; here we compute simply from chart range:
    const gross_profit = (salesForChart.data ?? []).reduce((gp, r: any) => {
      const priceUsed = Number(r.unit_price ?? unit_price_now)
      return gp + (priceUsed - unit_cost_now) * Number(r.quantity ?? 0)
    }, 0)
    const total_qty = (salesForChart.data ?? []).reduce((s, r: any) => s + Number(r.quantity ?? 0), 0)
    const total_revenue = (salesForChart.data ?? []).reduce((s, r: any) => s + Number(r.unit_price ?? 0) * Number(r.quantity ?? 0), 0)

    /* ---------- Seasonality (kept as last 12 months) ---------- */
    const seas = await supabaseService.rpc('product_seasonality_last12', { p_product_id: productId })
    if (seas.error) return res.status(500).json({ error: seas.error.message })

    /* ---------- Top customers (last 12 months) ---------- */
    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    return res.json({
      product: prod.data,
      monthly, // follows selected mode
      seasonality: (seas.data ?? []).map((r: any) => ({ month_num: r.month_num, avg_qty: Number(r.avg_qty) || 0 })),
      topCustomers: (topRes.data ?? []).map((r: any) => ({
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        qty: Number(r.qty) || 0
      })),
      pricing: {
        average_selling_price: asp,
        current_unit_cost: unit_cost_now,
        current_unit_price: unit_price_now
      },
      profit_window: {
        mode,
        year: mode === 'year' ? year : undefined,
        total_qty,
        total_revenue,
        unit_cost_used: unit_cost_now,
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
