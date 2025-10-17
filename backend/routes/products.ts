import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** Helpers */
const startOfMonthISO = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

function lastNMonthsUTC(n: number): string[] {
  const now = new Date()
  const arr: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    arr.push(startOfMonthISO(dt))
  }
  return arr
}
function monthKeyFromDateStr(isoDate: string): string {
  if (!isoDate || isoDate.length < 7) return ''
  const y = isoDate.slice(0, 4)
  const m = isoDate.slice(5, 7)
  return `${y}-${m}-01`
}

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)

type SaleRow = { date: string; quantity: number; unit_price: number | null }
type PriceRow = { effective_date: string; unit_cost: number | null }

router.get('/products/:id/overview', async (req, res) => {
  try {
    const productId = String(req.params.id)
    const mode = String(req.query.mode || 'last12')
    const year = req.query.year ? Number(req.query.year) : undefined
    const top = Math.max(1, Math.min(Number(req.query.top ?? 5), 5))

    // product header
    const prod = await supabaseService
      .from('products')
      .select('id,name')
      .eq('id', productId)
      .single()
    if (prod.error || !prod.data) return res.status(404).json({ error: 'Product not found' })

    // build chart range
    let chartStartISO: string
    let chartEndISO: string
    if (mode === 'year' && year && Number.isFinite(year)) {
      chartStartISO = `${year}-01-01`
      chartEndISO = `${year}-12-31`
    } else {
      const months = lastNMonthsUTC(12)
      chartStartISO = `${months[0]}`
      const last = months[months.length - 1]
      const end = new Date(Date.UTC(+last.slice(0, 4), +last.slice(5, 7), 0))
      chartEndISO = end.toISOString().slice(0, 10)
    }

    // sales in chart range (used for chart and profit window)
    const sChart = await supabaseService
      .from('sales')
      .select('date,quantity,unit_price')
      .eq('product_id', productId)
      .gte('date', chartStartISO)
      .lte('date', chartEndISO)
      .order('date', { ascending: true })

    if (sChart.error) return res.status(500).json({ error: sChart.error.message })
    const salesForChart: SaleRow[] = (sChart.data ?? []).map(r => ({
      date: String(r.date),
      quantity: Number(r.quantity ?? 0),
      unit_price: r.unit_price == null ? null : Number(r.unit_price)
    }))

    // prices up to chart end date (to lookup historical cost)
    const pRows = await supabaseService
      .from('product_prices')
      .select('effective_date,unit_cost')
      .eq('product_id', productId)
      .lte('effective_date', chartEndISO)
      .order('effective_date', { ascending: true })
    if (pRows.error) return res.status(500).json({ error: pRows.error.message })

    const prices: PriceRow[] = (pRows.data ?? []).map(r => ({
      effective_date: String(r.effective_date),
      unit_cost: r.unit_cost == null ? null : Number(r.unit_cost)
    }))

    // current inventory + current price for display only
    const inv = await supabaseService
      .from('inventory_current')
      .select('on_hand,backorder')
      .eq('product_id', productId)
      .maybeSingle()
    const cur = await supabaseService
      .from('v_product_current_price')
      .select('unit_cost,unit_price')
      .eq('product_id', productId)
      .maybeSingle()

    const on_hand = Number(inv.data?.on_hand ?? 0)
    const backorder = Number(inv.data?.backorder ?? 0)
    const unit_cost_now = Number(cur.data?.unit_cost ?? 0)
    const unit_price_now = Number(cur.data?.unit_price ?? 0)

    // ---------- Monthly chart series ----------
    // scaffold for the chosen range
    const scaffold: string[] = (() => {
      if (mode === 'year' && year && Number.isFinite(year)) {
        return Array.from({ length: 12 }, (_, i) => {
          const d = new Date(Date.UTC(year, i, 1))
          return startOfMonthISO(d)
        })
      }
      return lastNMonthsUTC(12)
    })()
    const monthIndex = new Map(scaffold.map((m, i) => [m, i]))
    const monthlyQty = Array(scaffold.length).fill(0)
    for (const r of salesForChart) {
      const key = monthKeyFromDateStr(r.date)
      const idx = monthIndex.get(key)
      if (idx != null) monthlyQty[idx] += r.quantity
    }
    const monthly = scaffold.map((m, i) => ({ month: `${m}-01`, qty: monthlyQty[i] }))

    // ---------- Last 12 months stats (weighted moq etc.) ----------
    const months12 = lastNMonthsUTC(12)
    const s12 = await supabaseService
      .from('sales')
      .select('date,quantity')
      .eq('product_id', productId)
      .gte('date', months12[0])
      .lte(
        'date',
        (() => {
          const end = new Date(Date.UTC(+months12[11].slice(0, 4), +months12[11].slice(5, 7), 0))
          return end.toISOString().slice(0, 10)
        })()
      )
    if (s12.error) return res.status(500).json({ error: s12.error.message })

    const monthIndex12 = new Map(months12.map((m, i) => [m, i]))
    const qty12 = Array(12).fill(0)
    for (const r of (s12.data ?? [])) {
      const key = monthKeyFromDateStr(String(r.date))
      const idx = monthIndex12.get(key)
      if (idx != null) qty12[idx] += Number(r.quantity ?? 0)
    }
    const weightedSum = qty12.reduce((acc, q, i) => acc + q * weights12[i], 0)
    const weightedAvg12 = wSum12 ? weightedSum / wSum12 : 0
    const sigma12 = (() => {
      const mean = qty12.reduce((a, b) => a + b, 0) / (qty12.length || 1)
      const v = qty12.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (qty12.length || 1)
      return Math.sqrt(v)
    })()
    const weighted_moq = Math.ceil(weightedAvg12 * 4) // your 4-month coverage

    // ---------- Accurate profit window over chart range ----------
    // revenue: sum(qty * COALESCE(unit_price,0))
    // cost: for each sale, use latest cost with effective_date <= sale.date
    // (prices is sorted asc by effective_date)
    let rev = 0
    let qty = 0
    let cost = 0
    let pIdx = prices.length - 1 // start from end for quick backwards search

    function costAt(dateISO: string): number {
      // walk back until effective_date <= sale.date
      while (pIdx >= 0 && prices[pIdx].effective_date > dateISO) pIdx--
      if (pIdx >= 0) return Number(prices[pIdx].unit_cost ?? 0)
      return 0 // no price before the sale -> cost 0
    }

    for (const r of salesForChart) {
      const uprice = Number(r.unit_price ?? 0)
      const q = Number(r.quantity ?? 0)
      const c = costAt(r.date)
      rev += q * uprice
      qty += q
      cost += q * c
    }
    const gp = rev - cost
    const asp = qty > 0 && rev > 0 ? rev / qty : unit_price_now

    // ---------- Seasonality & top customers (unchanged) ----------
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
        average_selling_price: asp,
        current_unit_cost: unit_cost_now,
        current_unit_price: unit_price_now
      },
      profit_window: {
        mode,
        year: mode === 'year' ? year : undefined,
        total_qty: qty,
        total_revenue: rev,
        unit_cost_used: unit_cost_now, // display only
        gross_profit: gp
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
