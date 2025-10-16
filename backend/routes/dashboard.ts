// backend/routes/dashboard.ts
import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** Dates (UTC, month-safe) */
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2,'0')}`
const monthStart = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
const last12Start = () => monthStart(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)))
const todayISO = () => ymd(new Date())

/** Weighted MOQ helpers (weights 1..12 over last 12 monthly buckets) */
const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)

type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }
type PriceRow = { product_id: string; effective_date: string; unit_cost: number | null }
type InvRow = { product_id: string; on_hand: number | null }
type NameRow = { id: string; name: string | null }

function keyMonthFromDate(dateIso: string): string {
  // YYYY-MM-01 for bucketing
  const y = dateIso.slice(0, 4)
  const m = dateIso.slice(5, 7)
  return `${y}-${m}-01`
}

/** Build a binary-searchable price timeline per product */
function buildCostTimelines(prices: PriceRow[]) {
  // product_id -> sorted [{d, c}]
  const map = new Map<string, Array<{ d: string; c: number }>>()
  for (const r of prices) {
    const pid = String(r.product_id)
    const c = Number(r.unit_cost ?? 0)
    const d = String(r.effective_date)
    const arr = map.get(pid) ?? []
    arr.push({ d, c })
    map.set(pid, arr)
  }
  for (const [pid, arr] of map) {
    arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    map.set(pid, arr)
  }
  return map
}

/** Get unit_cost on saleDate (last effective on/before saleDate). Fallback 0 if none. */
function costAtDate(timeline: Array<{ d: string; c: number }> | undefined, saleDate: string): number {
  if (!timeline || timeline.length === 0) return 0
  // binary search last <= saleDate
  let lo = 0, hi = timeline.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timeline[mid].d <= saleDate) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans >= 0 ? timeline[ans].c : 0
}

router.get('/dashboard/overview', async (_req, res) => {
  try {
    /** 1) Simple counts */
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    /** 2) Sales in last 12 months (inclusive) */
    const start12 = last12Start()
    const endDate = todayISO()
    const salesQ = await supabaseService
      .from('sales')
      .select('product_id,date,quantity,unit_price')
      .gte('date', start12)
      .lte('date', endDate)

    if (salesQ.error) return res.status(500).json({ error: salesQ.error.message })
    const sales = (salesQ.data ?? []) as SaleRow[]

    /** 3) Names */
    const namesQ = await supabaseService.from('products').select('id,name')
    if (namesQ.error) return res.status(500).json({ error: namesQ.error.message })
    const nameMap = new Map<string, string>((namesQ.data as NameRow[]).map(r => [String(r.id), r.name ?? '(unnamed product)']))

    /** 4) Current inventory (for at-risk) */
    const invQ = await supabaseService.from('inventory_current').select('product_id,on_hand')
    if (invQ.error) return res.status(500).json({ error: invQ.error.message })
    const onHandMap = new Map<string, number>((invQ.data as InvRow[]).map(r => [String(r.product_id), Number(r.on_hand ?? 0)]))

    /** 5) Prices (historical cost) needed for GP-at-sale-date */
    // Only fetch prices for products we actually saw in sales (keeps payload light)
    const productIds = Array.from(new Set(sales.map(s => String(s.product_id))))
    let prices: PriceRow[] = []
    if (productIds.length > 0) {
      const priceQ = await supabaseService
        .from('product_prices')
        .select('product_id,effective_date,unit_cost')
        .in('product_id', productIds)
        .lte('effective_date', endDate)

      if (priceQ.error) return res.status(500).json({ error: priceQ.error.message })
      prices = (priceQ.data ?? []) as PriceRow[]
    }
    const costTimeline = buildCostTimelines(prices)

    /** 6) Per-product aggregates for last 12 months using historical cost */
    const monthIdx = new Map<string, number>()
    // Build last-12 month keys (ascending) for MOQ buckets
    const months: string[] = []
    {
      const now = new Date()
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
        const key = monthStart(d)
        months.push(key)
      }
      months.forEach((m, i) => monthIdx.set(m, i))
    }

    const perProdMonthly = new Map<string, number[]>() // length 12
    const lastSaleDate = new Map<string, string>()
    const qtyMap = new Map<string, number>()
    const revenueMap = new Map<string, number>()
    const grossProfitMap = new Map<string, number>()

    for (const s of sales) {
      const pid = String(s.product_id)
      const q = Number(s.quantity ?? 0)
      const price = Number(s.unit_price ?? 0)
      const d = String(s.date)

      qtyMap.set(pid, (qtyMap.get(pid) ?? 0) + q)
      revenueMap.set(pid, (revenueMap.get(pid) ?? 0) + q * price)

      const uc = costAtDate(costTimeline.get(pid), d) // historical cost at sale date
      const gp = (price - uc) * q
      grossProfitMap.set(pid, (grossProfitMap.get(pid) ?? 0) + gp)

      // Fill monthly buckets for MOQ calc
      const mk = keyMonthFromDate(d)
      const idx = monthIdx.get(mk)
      if (idx != null) {
        const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
        arr[idx] += q
        perProdMonthly.set(pid, arr)
      }
      const prev = lastSaleDate.get(pid)
      if (!prev || d > prev) lastSaleDate.set(pid, d)
    }

    // Totals (12m)
    const sales_12m_qty = Array.from(qtyMap.values()).reduce((a, b) => a + b, 0)
    const sales_12m_revenue = Array.from(revenueMap.values()).reduce((a, b) => a + b, 0)

    /** 7) At-Risk: weighted MOQ vs OnHand; keep top 20 */
    type AtRiskRow = { product_id: string; product_name: string; on_hand: number; weighted_moq: number; gap: number; last_sale_date: string | null }
    const atRisk: AtRiskRow[] = []

    const atRiskIds = new Set<string>([
      ...Array.from(onHandMap.keys()),
      ...Array.from(perProdMonthly.keys())
    ])

    for (const pid of atRiskIds) {
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((acc, qty, i) => acc + qty * weights12[i], 0)
      const wavg = wSum12 > 0 ? weightedSum / wSum12 : 0
      const weighted_moq = Math.max(0, Math.ceil(wavg))

      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)

      if (gap > 0) {
        atRisk.push({
          product_id: pid,
          product_name: nameMap.get(pid) ?? '(unnamed product)',
          on_hand: onHand,
          weighted_moq,
          gap,
          last_sale_date: lastSaleDate.get(pid) ?? null
        })
      }
    }

    atRisk.sort((a, b) => b.gap - a.gap)
    const atRiskTop = atRisk.slice(0, 20) // <= change this if you need more/less

    /** 8) Top Products ranked by GROSS PROFIT over last 12 months (using historical cost) */
    type TopRow = { product_id: string; product_name: string; qty_12m: number; revenue_12m: number; gross_profit_12m: number }
    const topRows: TopRow[] = []

    for (const pid of qtyMap.keys()) {
      const qty = qtyMap.get(pid) ?? 0
      const rev = revenueMap.get(pid) ?? 0
      const gp = grossProfitMap.get(pid) ?? 0
      topRows.push({
        product_id: pid,
        product_name: nameMap.get(pid) ?? '(unnamed product)',
        qty_12m: qty,
        revenue_12m: rev,
        gross_profit_12m: gp
      })
    }

    // Rank by gross profit desc; pick top 20 (tweak if you prefer)
    topRows.sort((a, b) => b.gross_profit_12m - a.gross_profit_12m)
    const topProducts = topRows.slice(0, 20)

    /** 9) Respond */
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty,
        sales_12m_revenue
      },
      atRisk: atRiskTop,
      topProducts
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
