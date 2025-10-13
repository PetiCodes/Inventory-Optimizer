import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware'
import { supabaseService } from '../src/supabase'

const router = Router()

function ym(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}
function lastNMonths(n: number): string[] {
  const now = new Date()
  const arr: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    arr.push(ym(d))
  }
  return arr
}
function stddev(nums: number[]): number {
  if (!nums.length) return 0
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  const v = nums.reduce((acc, x) => acc + Math.pow(x - avg, 2), 0) / nums.length
  return Math.sqrt(v)
}

router.get('/products/search', requireAuth, async (req, res) => {
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
 * GET /api/products/:id/overview?months=12&top=5
 * - months: 12,24,48,... (we still zero-fill consecutive months)
 * - seasonality uses only last 12 months
 * - top customers up to 'top' (max 5)
 * - ASP (average selling price) computed from sales.unit_price (qty-weighted).
 *   If no unit_price in sales, we blend with inventory current price as fallback average.
 * - Gross profit uses actual sales prices: sum(quantity*(unit_price - cost_current)).
 */
router.get('/products/:id/overview', requireAuth, async (req, res) => {
  try {
    const productId = String(req.params.id)
    let months = Math.max(12, Number(req.query.months ?? 12))
    months = Math.min(1200, months) // cap
    const top = Math.max(1, Math.min(Number(req.query.top ?? 5), 5))

    const prod = await supabaseService.from('products').select('id,name').eq('id', productId).single()
    if (prod.error || !prod.data) return res.status(404).json({ error: 'Product not found' })

    // Monthly raw in window
    const monthlyRaw = await supabaseService.rpc('product_monthly_totals_window', { p_product_id: productId, p_months: months })
    if (monthlyRaw.error) return res.status(500).json({ error: monthlyRaw.error.message })

    const map = new Map<string, number>()
    for (const r of monthlyRaw.data ?? []) {
      const key = String(r.month).slice(0, 7)
      map.set(key, (map.get(key) || 0) + (Number(r.total_qty) || 0))
    }
    const monthsList = lastNMonths(months) // oldest -> newest
    const series = monthsList.map(mm => ({ month: `${mm}-01`, qty: map.get(mm) ?? 0 }))

    // Recency-weighted average over *last 12* months of the series tail (zeros included).
    const last12 = series.slice(-12)
    const weights = Array.from({ length: 12 }, (_, i) => i + 1)
    const wSum = weights.reduce((a, b) => a + b, 0) // 78
    const weightedSum = last12.reduce((acc, r, idx) => acc + r.qty * weights[idx], 0)
    const weightedAvg12 = wSum > 0 ? (weightedSum / wSum) : 0
    const sigma12 = stddev(last12.map(s => s.qty))

    // Inventory & current cost/price
    const inv = await supabaseService.from('inventory_current').select('on_hand,backorder').eq('product_id', productId).maybeSingle()
    const price = await supabaseService.from('v_product_current_price').select('unit_cost,unit_price,effective_date').eq('product_id', productId).maybeSingle()
    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)
    const unit_cost_now = Number(price.data?.unit_cost ?? 0)
    const unit_price_now = Number(price.data?.unit_price ?? 0)

    // ASP from sales (qty-weighted); if absent, blend with current price
    const q = await supabaseService
      .from('sales')
      .select('quantity, unit_price')
      .eq('product_id', productId)
      .gte('date', `${monthsList[0]}-01`)

    if (q.error) return res.status(500).json({ error: q.error.message })
    const salesRows = q.data ?? []
    const wRevenue = salesRows.reduce((acc: number, r: any) => acc + (Number(r.unit_price ?? 0) * Number(r.quantity ?? 0)), 0)
    const wQty = salesRows.reduce((acc: number, r: any) => acc + Number(r.quantity ?? 0), 0)

    let asp: number
    if (wQty > 0 && wRevenue > 0) {
      asp = wRevenue / wQty
      // optional blend with current price (simple average) if you insist:
      // asp = (asp + unit_price_now) / 2
    } else {
      asp = unit_price_now // fallback to current price if no sales price data in window
    }

    // Profit window using function (months window)
    const profit = await supabaseService.rpc('product_profit_window', { p_product_id: productId, p_months: months })
    if (profit.error) return res.status(500).json({ error: profit.error.message })
    const p = profit.data?.[0] ?? { total_qty: 0, total_revenue: 0, unit_cost: unit_cost_now, gross_profit: 0 }

    // Seasonality last 12 months only
    const seas = await supabaseService.rpc('product_seasonality_last12', { p_product_id: productId })
    if (seas.error) return res.status(500).json({ error: seas.error.message })

    // Top customers up to 5
    const topRes = await supabaseService.rpc('product_top_customers', { p_product_id: productId, p_limit: top })
    if (topRes.error) return res.status(500).json({ error: topRes.error.message })

    // Build response
    return res.json({
      product: prod.data,
      monthly: series,                            // N months, zero-filled
      seasonality: (seas.data ?? []).map((r: any) => ({ month_num: r.month_num, avg_qty: Number(r.avg_qty) || 0 })),
      topCustomers: (topRes.data ?? []).map((r: any) => ({ customer_id: r.customer_id, customer_name: r.customer_name, qty: Number(r.qty)||0 })),
      pricing: {
        average_selling_price: asp,
        current_unit_cost: unit_cost_now,
        current_unit_price: unit_price_now
      },
      profit_window: {
        months,
        total_qty: Number(p.total_qty) || 0,
        total_revenue: Number(p.total_revenue) || 0,
        unit_cost_used: Number(p.unit_cost) || unit_cost_now,
        gross_profit: Number(p.gross_profit) || 0
      },
      stats12: {
        weighted_avg_12m: weightedAvg12,
        sigma_12m: sigma12
      },
      inventory: { on_hand, backorder }
    })
  } catch (e: any) {
    console.error('GET /products/:id/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
