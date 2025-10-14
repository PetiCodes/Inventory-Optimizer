// backend/routes/dashboard.ts
import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

// ---- helpers (UTC, month scaffolds, stddev, weighting) ----
function ymUTC(d: Date) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function lastNMonthsUTC(n: number) {
  const now = new Date()
  const anchor = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: { key: string; y: number; m0: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = monthStartUTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i)
    out.push({ key: ymUTC(d), y: d.getUTCFullYear(), m0: d.getUTCMonth() })
  }
  return out
}
const ORDER_COVERAGE_MONTHS = 4

// ---- GET /api/dashboard/overview ----
router.get('/dashboard/overview', async (_req, res) => {
  try {
    // Counts
    const prodCount = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    const custCount = await supabaseService.from('customers').select('id', { count: 'exact', head: true })

    if (prodCount.error) return res.status(500).json({ error: prodCount.error.message })
    if (custCount.error) return res.status(500).json({ error: custCount.error.message })

    // Sales last 12 months (qty + revenue)
    const last12 = lastNMonthsUTC(12)
    const start12 = `${last12[0].key}-01`
    const end12 = (() => {
      const t = last12[last12.length - 1]
      const end = new Date(Date.UTC(t.y, t.m0 + 1, 0))
      return end.toISOString().slice(0, 10)
    })()

    const sales12 = await supabaseService
      .from('sales')
      .select('product_id, date, quantity, unit_price')

    if (sales12.error) return res.status(500).json({ error: sales12.error.message })

    // Filter in node for 12m range (keeps compatibility if RLS not tuned)
    const s12 = (sales12.data ?? []).filter((r: any) => {
      const d = String(r.date)
      return d >= start12 && d <= end12
    })

    const total_qty_12 = s12.reduce((s, r: any) => s + Number(r.quantity || 0), 0)
    const total_rev_12 = s12.reduce((s, r: any) => s + Number(r.quantity || 0) * Number(r.unit_price || 0), 0)

    // Inventory snapshot
    const invCur = await supabaseService.from('inventory_current').select('product_id,on_hand,backorder')
    if (invCur.error) return res.status(500).json({ error: invCur.error.message })
    const invMap = new Map<string, { on_hand: number; backorder: number }>()
    for (const r of invCur.data ?? []) {
      invMap.set(String(r.product_id), { on_hand: Number(r.on_hand || 0), backorder: Number(r.backorder || 0) })
    }

    // Current cost (needed for GP)
    const priceCur = await supabaseService
      .from('v_product_current_price')
      .select('product_id, unit_cost, unit_price, effective_date')
    if (priceCur.error) return res.status(500).json({ error: priceCur.error.message })
    const costMap = new Map<string, { cost: number; price: number }>()
    for (const r of priceCur.data ?? []) {
      costMap.set(String(r.product_id), { cost: Number(r.unit_cost || 0), price: Number(r.unit_price || 0) })
    }

    // Build 12-month monthly per product (for weighted MOQ + top products)
    const byProdMonth = new Map<
      string,
      { [key: string]: number } // key 'YYYY-MM' => qty
    >()
    const last12Keys = last12.map(x => x.key)
    for (const row of s12) {
      const pid = String(row.product_id)
      const d = new Date(String(row.date))
      const key = ymUTC(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
      if (!last12Keys.includes(key)) continue
      if (!byProdMonth.has(pid)) byProdMonth.set(pid, {})
      const pm = byProdMonth.get(pid)!
      pm[key] = (pm[key] ?? 0) + Number(row.quantity || 0)
    }

    // Compute Weighted MOQ + 12m totals per product
    const weights = Array.from({ length: 12 }, (_, i) => i + 1) // 1..12
    const sumW = weights.reduce((a, b) => a + b, 0) // 78

    type AtRiskRow = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
      last_sale_date: string | null
    }
    type TopRow = {
      product_id: string
      product_name: string
      qty_12m: number
      revenue_12m: number
      gross_profit_12m: number
    }

    const allProds = await supabaseService.from('products').select('id,name')
    if (allProds.error) return res.status(500).json({ error: allProds.error.message })

    const nameMap = new Map<string, string>(
    (allProds.data ?? []).map((p: any) => [String(p.id), String(p.name ?? 'Unknown')])
)


    // Compute per-product metrics
    const atRisk: AtRiskRow[] = []
    const top: TopRow[] = []

    // group s12 rows for revenue/gp and last sale date
    const rowsByPid = new Map<string, any[]>()
    for (const r of s12) {
      const pid = String(r.product_id)
      if (!rowsByPid.has(pid)) rowsByPid.set(pid, [])
      rowsByPid.get(pid)!.push(r)
    }

    for (const [pid, rows] of rowsByPid.entries()) {
      // monthly qty vector in last-12 order
      const pm = byProdMonth.get(pid) || {}
      const qtyVec = last12Keys.map(k => Number(pm[k] || 0))
      const weightedAvg = qtyVec.reduce((acc, q, i) => acc + q * weights[i], 0) / sumW
      const weighted_moq = Math.ceil(weightedAvg * ORDER_COVERAGE_MONTHS)

      // inventory snapshot
      const inv = invMap.get(pid) || { on_hand: 0, backorder: 0 }
      const gap = weighted_moq - inv.on_hand

      // last sale date
      let last_sale_date: string | null = null
      for (const r of rows) {
        const d = String(r.date)
        if (!last_sale_date || d > last_sale_date) last_sale_date = d
      }

      // top metrics
      const cost = costMap.get(pid)?.cost ?? 0
      const qty_12m = rows.reduce((s, r) => s + Number(r.quantity || 0), 0)
      const revenue_12m = rows.reduce((s, r) => s + Number(r.quantity || 0) * Number(r.unit_price || 0), 0)
      const gross_profit_12m = rows.reduce((gp, r) => {
        const price = Number(r.unit_price || 0)
        const qty = Number(r.quantity || 0)
        return gp + (price - cost) * qty
      }, 0)

      // Push at-risk only if gap > 0
      if (gap > 0) {
        atRisk.push({
          product_id: pid,
          product_name: nameMap.get(pid) || 'Unknown',
          on_hand: inv.on_hand,
          weighted_moq,
          gap,
          last_sale_date
        })
      }

      top.push({
        product_id: pid,
        product_name: nameMap.get(pid) || 'Unknown',
        qty_12m,
        revenue_12m,
        gross_profit_12m
      })
    }

    // Sort at-risk by largest gap, top by qty descending
    atRisk.sort((a, b) => b.gap - a.gap)
    top.sort((a, b) => b.qty_12m - a.qty_12m)

    return res.json({
      totals: {
        products: prodCount.count ?? 0,
        customers: custCount.count ?? 0,
        sales_12m_qty: total_qty_12,
        sales_12m_revenue: total_rev_12
      },
      atRisk: atRisk.slice(0, 50), // cap to 50 rows for dashboard
      topProducts: top.slice(0, 20) // cap to 20
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
