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
  // expects YYYY-MM-DD; returns YYYY-MM-01
  if (!isoDate || isoDate.length < 7) return ''
  const y = isoDate.slice(0, 4)
  const m = isoDate.slice(5, 7)
  return `${y}-${m}-01`
}

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1) // 1..12
const wSum12 = weights12.reduce((a, b) => a + b, 0) // 78

router.get('/dashboard/overview', async (_req, res) => {
  try {
    // 1) Totals
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    // 2) Last 12 months sales
    const months = lastNMonthsUTC(12) // ascending list of YYYY-MM-01
    const start12 = months[0] // inclusive

    const sales12 = await supabaseService
      .from('sales')
      .select('product_id, date, quantity, unit_price')
      .gte('date', start12)

    if (sales12.error) return res.status(500).json({ error: sales12.error.message })
    const salesRows = (sales12.data ?? []) as Array<{
      product_id: string
      date: string
      quantity: number
      unit_price: number | null
    }>

    let salesQty12 = 0
    let salesRevenue12 = 0
    for (const r of salesRows) {
      const q = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      salesQty12 += q
      salesRevenue12 += q * up
    }

    // 3) Current unit cost map
    const costNow = await supabaseService
      .from('v_product_current_price')
      .select('product_id, unit_cost')
    if (costNow.error) return res.status(500).json({ error: costNow.error.message })
    const costMap = new Map<string, number>(
      (costNow.data ?? []).map((r: any) => [String(r.product_id), Number(r.unit_cost ?? 0)])
    )

    // 4) Current inventory (on hand)
    const inv = await supabaseService
      .from('inventory_current')
      .select('product_id, on_hand')
    if (inv.error) return res.status(500).json({ error: inv.error.message })
    const onHandMap = new Map<string, number>(
      (inv.data ?? []).map((r: any) => [String(r.product_id), Number(r.on_hand ?? 0)])
    )

    // 5) Build per-product monthly buckets for last 12 months
    const monthIndex = new Map<string, number>() // "YYYY-MM-01" => 0..11
    months.forEach((ym, idx) => monthIndex.set(ym, idx))

    const perProdMonthly = new Map<string, number[]>() // product_id -> qty[12]
    const lastSaleDate = new Map<string, string>()      // product_id -> last sale date

    for (const r of salesRows) {
      const pid = String(r.product_id)
      const key = monthKeyFromDateStr(String(r.date))
      if (!monthIndex.has(key)) continue
      const idx = monthIndex.get(key)! // 0..11

      let arr = perProdMonthly.get(pid)
      if (!arr) {
        arr = Array(12).fill(0)
        perProdMonthly.set(pid, arr)
      }
      arr[idx] += Number(r.quantity ?? 0)

      // track last sale
      const d = String(r.date ?? '')
      const prev = lastSaleDate.get(pid)
      if (!prev || d > prev) lastSaleDate.set(pid, d)
    }

    // 6) Aggregate qty & revenue for top-products
    const aggQty = new Map<string, number>()
    const aggRevenue = new Map<string, number>()
    for (const r of salesRows) {
      const pid = String(r.product_id)
      const q = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      aggQty.set(pid, (aggQty.get(pid) ?? 0) + q)
      aggRevenue.set(pid, (aggRevenue.get(pid) ?? 0) + q * up)
    }

    // 7) Collect product ids actually used (sales or inventory)
    const productIds = new Set<string>([
      ...Array.from(onHandMap.keys()),
      ...Array.from(perProdMonthly.keys()),
      ...Array.from(aggQty.keys()),
    ])

    // Fetch only those product names to avoid any mismatch
    let nameMap = new Map<string, string>()
    if (productIds.size > 0) {
      const idList = Array.from(productIds)
      const chunks: string[][] = []
      for (let i = 0; i < idList.length; i += 1000) chunks.push(idList.slice(i, i + 1000))

      const temp = new Map<string, string>()
      for (const part of chunks) {
        const namesRes = await supabaseService.from('products').select('id,name').in('id', part)
        if (namesRes.error) return res.status(500).json({ error: namesRes.error.message })
        for (const row of namesRes.data ?? []) {
          const nm = String(row.name ?? '').trim()
          temp.set(String(row.id), nm || '(unnamed product)')
        }
      }
      nameMap = temp
    }

    // 8) Build at-risk list (weighted MOQ vs on hand)
    type AtRisk = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
      last_sale_date: string | null
    }
    const atRiskAll: AtRisk[] = []

    for (const pid of productIds) {
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((acc, qty, i) => acc + qty * weights12[i], 0)
      const wavg = wSum12 > 0 ? weightedSum / wSum12 : 0
      const weighted_moq = Math.ceil(wavg)

      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)

      if (gap > 0) {
        atRiskAll.push({
          product_id: pid,
          product_name: nameMap.get(pid) ?? '(unnamed product)',
          on_hand: onHand,
          weighted_moq,
          gap,
          last_sale_date: lastSaleDate.get(pid) ?? null
        })
      }
    }

    // Sort by gap and cap to top 20
    const atRisk = atRiskAll.sort((a, b) => b.gap - a.gap).slice(0, 20)

    // 9) Top products (revenue/gp over last 12)
    type TopRow = {
      product_id: string
      product_name: string
      qty_12m: number
      revenue_12m: number
      gross_profit_12m: number
    }

    const topCandidates: TopRow[] = []
    for (const [pid, qty] of aggQty.entries()) {
      const revenue = aggRevenue.get(pid) ?? 0
      const unitCost = costMap.get(pid) ?? 0
      const grossProfit = revenue - unitCost * qty

      topCandidates.push({
        product_id: pid,
        product_name: nameMap.get(pid) ?? '(unnamed product)',
        qty_12m: qty,
        revenue_12m: revenue,
        gross_profit_12m: grossProfit
      })
    }

    topCandidates.sort((a, b) => b.revenue_12m - a.revenue_12m)
    const topProducts = topCandidates.slice(0, 20)

    // 10) Respond
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty: salesQty12,
        sales_12m_revenue: salesRevenue12
      },
      atRisk,
      topProducts
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
