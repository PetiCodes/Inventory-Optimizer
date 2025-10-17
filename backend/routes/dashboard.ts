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

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1) // 1..12
const wSum12 = weights12.reduce((a, b) => a + b, 0) // 78

type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }
type NameRow = { id: string; name: string | null }
type InvRow  = { product_id: string; on_hand: number | null }

router.get('/dashboard/overview', async (_req, res) => {
  try {
    // 1) Totals
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    // 2) Last 12 months basic totals (qty/revenue)
    const months = lastNMonthsUTC(12)
    const start12 = months[0]

    const s12 = await supabaseService
      .from('sales')
      .select('product_id, date, quantity, unit_price')
      .gte('date', start12)

    if (s12.error) return res.status(500).json({ error: s12.error.message })
    const salesRows = (s12.data ?? []) as SaleRow[]

    let salesQty12 = 0
    let salesRevenue12 = 0
    for (const r of salesRows) {
      const q  = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      salesQty12 += q
      salesRevenue12 += q * up
    }

    // 3) Names (avoid “Unknown”)
    const namesQ = await supabaseService.from('products').select('id,name')
    if (namesQ.error) return res.status(500).json({ error: namesQ.error.message })
    const nameMap = new Map<string, string>(
      ((namesQ.data ?? []) as NameRow[]).map(r => [String(r.id), String(r.name ?? '')])
    )

    // 4) Current inventory (for at-risk)
    const invQ = await supabaseService.from('inventory_current').select('product_id,on_hand')
    if (invQ.error) return res.status(500).json({ error: invQ.error.message })
    const onHandMap = new Map<string, number>(
      ((invQ.data ?? []) as InvRow[]).map(r => [String(r.product_id), Number(r.on_hand ?? 0)])
    )

    // 5) Build per-product monthly qty buckets
    const monthIndex = new Map<string, number>() // "YYYY-MM-01" => 0..11
    months.forEach((ym, idx) => monthIndex.set(ym, idx))

    const perProdMonthly = new Map<string, number[]>()
    const lastSaleDate = new Map<string, string>()

    for (const r of salesRows) {
      const pid = String(r.product_id)
      const key = monthKeyFromDateStr(String(r.date))
      if (!monthIndex.has(key)) continue
      const idx = monthIndex.get(key)!
      let arr = perProdMonthly.get(pid)
      if (!arr) {
        arr = Array(12).fill(0)
        perProdMonthly.set(pid, arr)
      }
      arr[idx] += Number(r.quantity ?? 0)

      const d = String(r.date ?? '')
      const prev = lastSaleDate.get(pid)
      if (!prev || d > prev) lastSaleDate.set(pid, d)
    }

    // 6) At-Risk (weighted MOQ over last 12, compare to on_hand) — TOP 20 by gap
    type AtRiskRow = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
      last_sale_date: string | null
    }

    const productIds = new Set<string>([
      ...Array.from(onHandMap.keys()),
      ...Array.from(perProdMonthly.keys())
    ])

    const atRisk: AtRiskRow[] = []
    for (const pid of productIds) {
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((acc, qty, i) => acc + qty * weights12[i], 0)
      const weighted_moq = Math.ceil(wSum12 > 0 ? (weightedSum / wSum12) : 0)

      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)
      if (gap > 0) {
        const nm = nameMap.get(pid)
        atRisk.push({
          product_id: pid,
          product_name: (nm && nm.trim().length > 0) ? nm : '(unnamed)',
          on_hand: onHand,
          weighted_moq,
          gap,
          last_sale_date: lastSaleDate.get(pid) ?? null
        })
      }
    }
    atRisk.sort((a, b) => b.gap - a.gap)
    const atRiskTop20 = atRisk.slice(0, 20)

    // 7) Top products — use the cached accurate 12m GP and rank by gross_profit_12m
    // You created the RPC earlier; it reads v_product_profit_cache and orders by GP desc.
    const topRpc = await supabaseService.rpc('rpc_top_products_12m', { p_limit: 20 })
    if (topRpc.error) return res.status(500).json({ error: topRpc.error.message })
    const topProducts = (topRpc.data ?? []).map((r: any) => ({
      product_id: String(r.product_id),
      product_name: (() => {
        const nm = nameMap.get(String(r.product_id))
        return (nm && nm.trim().length > 0) ? nm : '(unnamed)'
      })(),
      qty_12m: Number(r.qty_12m ?? 0),
      revenue_12m: Number(r.revenue_12m ?? 0),
      gross_profit_12m: Number(r.gross_profit_12m ?? 0)
    }))

    // 8) Respond
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty: salesQty12,
        sales_12m_revenue: salesRevenue12
      },
      atRisk: atRiskTop20,
      topProducts
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', {
      message: e?.message,
      details: e?.stack || e
    })
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
