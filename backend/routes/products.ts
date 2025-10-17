// routes/products.ts
import { Router } from 'express'
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
 * Monthly series follows mode.
 * stats12 (weighted avg, sigma, weighted_moq) always computed on the *last 12 months* ending now.
 * Gross profit in the selected window is computed ACCURATELY using the cost at/ before sale date.
 * For past-12-month highlights, we additionally read the cached values from v_product_profit_cache.
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

    // Pull sales in the chosen range (for chart + profit window calc)
    const salesQ = await supabaseService
      .from('sales')
      .select('date, quantity, unit_price')
      .eq('product_id', productId)
      .gte('date', rangeStartISO)
      .lte('date', rangeEndISO)

    if (salesQ.error) return res.status(500).json({ error: salesQ.error.message })
    const salesRows = (salesQ.data ?? []) as Array<{ date: string; quantity: number; unit_price: number | null }>

    // Preload all product prices up to the end of the range, to compute historical cost per sale
    const ppQ = await supabaseService
      .from('product_prices')
      .select('effective_date, unit_cost')
      .eq('product_id', productId)
      .lte('effective_date', rangeEndISO)
      .order('effective_date', { ascending: true })
    if (ppQ.error) return res.status(500).json({ error: ppQ.error.message })

    const priceTimeline = (ppQ.data ?? []).map(r => ({
      d: String(r.effective_date),
      c: Number(r.unit_cost ?? 0)
    }))

    // Helper: cost at/ before given YYYY-MM-DD
    function costOn(iso: string): number {
      if (priceTimeline.length === 0) return 0
      // binary search latest d <= iso
      let lo = 0, hi = priceTimeline.length - 1, ans = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (priceTimeline[mid].d <= iso) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
      }
      return ans >= 0 ? priceTimeline[ans].c : 0
    }

    // Monthly series
    const monthMap = new Map<string, number>()
    for (const r of salesRows) {
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
      .select('date, quantity')
      .eq('product_id', productId)
      .gte('date', last12StartISO)
      .lte('date', last12EndISO)
    if (sales12.error) return res.status(500).json({ error: sales12.error.message })

    const m12 = last12Scaffold.map(s => ({ key: s.key, qty: 0 }))
    for (const r of (sales12.data ?? [])) {
      const d = new Date(String(r.date))
      const key = ymUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      const bucket = m12.find(b => b.key === key)
      if (bucket) bucket.qty += Number(r.quantity || 0)
    }
    const weights = m12.map((_, i) => i + 1) // 1..12
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

    const curPrice = await supabaseService
      .from('v_product_current_price')
      .select('unit_cost,unit_price,effective_date')
      .eq('product_id', productId)
      .maybeSingle()

    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)
    const unit_cost_now = Number(curPrice.data?.unit_cost ?? 0)
    const unit_price_now = Number(curPrice.data?.unit_price ?? 0)

    /* ---------- Profit window over the chart range (ACCURATE historical cost) ---------- */
    let total_qty = 0
    let total_rev = 0
    let total_cost = 0
    for (const s of salesRows) {
      const q = Number(s.quantity ?? 0)
      const up = Number(s.unit_price ?? 0)
      const c  = costOn(String(s.date)) // cost at/ before that sale date
      total_qty  += q
      total_rev  += q * up
      total_cost += q * c
    }
    const gross_profit = total_rev - total_cost

    /* ---------- ASP for the selected range ---------- */
    const asp = total_qty > 0 ? (total_rev / total_qty) : unit_price_now

    /* ---------- Cached 12M highlights (from view) ---------- */
    let cache12: { qty_12m: number; revenue_12m: number; gross_profit_12m: number } | null = null
    {
      // Prefer the view if present; fall back to table if view not found
      const q1 = await supabaseService
        .from('v_product_profit_cache')
        .select('qty_12m,revenue_12m,gross_profit_12m')
        .eq('product_id', productId)
        .maybeSingle()
      if (!q1.error && q1.data) {
        cache12 = {
          qty_12m: Number(q1.data.qty_12m ?? 0),
          revenue_12m: Number(q1.data.revenue_12m ?? 0),
          gross_profit_12m: Number(q1.data.gross_profit_12m ?? 0)
        }
      } else {
        const q2 = await supabaseService
          .from('product_profit_cache')
          .select('qty_12m,revenue_12m,gross_profit_12m')
          .eq('product_id', productId)
          .maybeSingle()
        if (!q2.error && q2.data) {
          cache12 = {
            qty_12m: Number(q2.data.qty_12m ?? 0),
            revenue_12m: Number(q2.data.revenue_12m ?? 0),
            gross_profit_12m: Number(q2.data.gross_profit_12m ?? 0)
          }
        }
      }
    }

    /* ---------- Top customers (last 12 months) ---------- */
    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    return res.json({
      product: prod.data,
      monthly, // follows selected mode
      seasonality: [], // (kept minimal; you can plug your existing RPC back if desired)
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
        total_revenue: total_rev,
        unit_cost_used: null, // per-sale historical costs used; keep for UI compatibility
        gross_profit
      },
      stats12: {
        weighted_avg_12m: weightedAvg12,
        sigma_12m: sigma12,
        weighted_moq
      },
      inventory: { on_hand, backorder },
      // Optional: expose cached 12m values so the UI can display them if desired
      cached12m: cache12
    })
  } catch (e: any) {
    console.error('GET /products/:id/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
