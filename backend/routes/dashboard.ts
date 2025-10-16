// routes/dashboard.ts
import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ───────────────────────── Date helpers ───────────────────────── */
const pad2 = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
const monthStart = (d: Date) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`

function last12Start(): string {
  const now = new Date()
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
  return monthStart(first)
}
const todayISO = () => ymd(new Date())

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1) // 1..12
const wSum12 = weights12.reduce((a, b) => a + b, 0)

function keyMonth(dateIso: string) {
  if (!dateIso || dateIso.length < 7) return ''
  return `${dateIso.slice(0, 4)}-${dateIso.slice(5, 7)}-01`
}

/* ───────────────────────── Retry that accepts "thenables" ─────────────────────────
   Supabase query builders are thenables (await-able) but not typed as Promise<T>.
   This wrapper coerces anything returned by fn() into an awaited result.
*/
async function withRetry<T = any>(fn: () => any, tries = 3, delayMs = 250): Promise<T> {
  let lastErr: any
  for (let i = 0; i < tries; i++) {
    try {
      // If fn returns a PostgrestFilterBuilder (thenable), this will await it correctly.
      const out = await Promise.resolve(fn())
      return out as T
    } catch (e: any) {
      lastErr = e
      await new Promise(r => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastErr
}

/* ───────────────────────── Build/read cost timelines ───────────────────────── */
type PriceRow = { product_id: string; effective_date: string; unit_cost: number | null }

function buildCostTimeline(prices: PriceRow[]) {
  const map = new Map<string, { d: string; c: number }[]>()
  for (const p of prices) {
    const pid = String(p.product_id)
    const arr = map.get(pid) ?? []
    arr.push({ d: String(p.effective_date), c: Number(p.unit_cost ?? 0) })
    map.set(pid, arr)
  }
  for (const [pid, arr] of map) arr.sort((a, b) => a.d.localeCompare(b.d))
  return map
}

function costAtDate(timeline: { d: string; c: number }[] | undefined, saleDate: string) {
  if (!timeline || !timeline.length) return 0
  // binary search: latest effective_date <= saleDate
  let lo = 0, hi = timeline.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (timeline[mid].d <= saleDate) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return ans >= 0 ? timeline[ans].c : 0
}

/* ───────────────────────── Chunked price fetch ───────────────────────── */
async function fetchPricesInChunks(
  productIds: string[],
  endDate: string
): Promise<PriceRow[]> {
  if (!productIds.length) return []
  const chunkSize = 800 // keep URL/query small
  const results: PriceRow[] = []
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const ids = productIds.slice(i, i + chunkSize)
    const { data, error } = await withRetry<{ data: PriceRow[]; error: any }>(() =>
      supabaseService
        .from('product_prices')
        .select('product_id,effective_date,unit_cost')
        .in('product_id', ids)
        .lte('effective_date', endDate)
    )
    if (error) throw error
    results.push(...(data ?? []))
  }
  return results
}

/* ───────────────────────── Route ───────────────────────── */
router.get('/dashboard/overview', async (_req, res) => {
  try {
    const start12 = last12Start()
    const endDate = todayISO()

    // 1) Parallel lightweight queries
    const [prodHead, custHead, salesQ, namesQ, invQ] = await Promise.all([
      supabaseService.from('products').select('id', { count: 'exact', head: true }),
      supabaseService.from('customers').select('id', { count: 'exact', head: true }),
      // last-12-month sales only
      supabaseService.from('sales')
        .select('product_id,date,quantity,unit_price')
        .gte('date', start12)
        .lte('date', endDate),
      supabaseService.from('products').select('id,name'),
      supabaseService.from('inventory_current').select('product_id,on_hand')
    ])

    if (prodHead.error) throw prodHead.error
    if (custHead.error) throw custHead.error
    if (salesQ.error) throw salesQ.error
    if (namesQ.error) throw namesQ.error
    if (invQ.error) throw invQ.error

    const productsCount = prodHead.count ?? 0
    const customersCount = custHead.count ?? 0

    type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }
    const sales = (salesQ.data ?? []) as SaleRow[]

    // Name map (fallback only if truly empty)
    const nameMap = new Map<string, string>(
      (namesQ.data ?? []).map((r: any) => {
        const nm = (r.name ?? '').toString().trim()
        return [String(r.id), nm || '(unnamed)']
      })
    )

    const onHandMap = new Map<string, number>((invQ.data ?? []).map((r: any) => [String(r.product_id), Number(r.on_hand ?? 0)]))

    // 2) Only fetch prices for products that appear in the last-12-month sales
    const productIds = Array.from(new Set(sales.map(s => String(s.product_id))))
    const priceData = await fetchPricesInChunks(productIds, endDate)
    const costTimeline = buildCostTimeline(priceData)

    // 3) Build month index for last 12
    const months: string[] = []
    const idxMap = new Map<string, number>()
    {
      const now = new Date()
      for (let i = 11; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
        const mk = monthStart(d)
        months.push(mk)
      }
      months.forEach((m, i) => idxMap.set(m, i))
    }

    // 4) Aggregate sales (qty, revenue, GP w/ historical cost), and per-product monthly
    const perProdMonthly = new Map<string, number[]>()
    const lastSaleDate = new Map<string, string>()
    const qtyMap = new Map<string, number>()
    const revenueMap = new Map<string, number>()
    const gpMap = new Map<string, number>()

    for (const s of sales) {
      const pid = String(s.product_id)
      const q = Number(s.quantity ?? 0)
      const up = Number(s.unit_price ?? 0)
      const d = String(s.date)

      // totals
      qtyMap.set(pid, (qtyMap.get(pid) ?? 0) + q)
      revenueMap.set(pid, (revenueMap.get(pid) ?? 0) + q * up)

      // historical GP
      const uc = costAtDate(costTimeline.get(pid), d)
      gpMap.set(pid, (gpMap.get(pid) ?? 0) + (up - uc) * q)

      // monthly bucket
      const mk = keyMonth(d)
      const idx = idxMap.get(mk)
      if (idx != null) {
        const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
        arr[idx] += q
        perProdMonthly.set(pid, arr)
      }

      const prev = lastSaleDate.get(pid)
      if (!prev || d > prev) lastSaleDate.set(pid, d)
    }

    const totalQty12 = Array.from(qtyMap.values()).reduce((a, b) => a + b, 0)
    const totalRev12 = Array.from(revenueMap.values()).reduce((a, b) => a + b, 0)

    // 5) At-Risk (weighted MOQ) — top 20
    type AtRiskRow = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
      last_sale_date: string | null
    }
    const atRisk: AtRiskRow[] = []
    const productUniverse = new Set<string>([
      ...Array.from(onHandMap.keys()),
      ...Array.from(perProdMonthly.keys())
    ])

    for (const pid of productUniverse) {
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((acc, qty, i) => acc + qty * weights12[i], 0)
      const wavg = weightedSum / wSum12
      const weighted_moq = Math.ceil(Math.max(0, wavg))
      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)
      if (gap > 0) {
        atRisk.push({
          product_id: pid,
          product_name: nameMap.get(pid) ?? '(unnamed)',
          on_hand: onHand,
          weighted_moq,
          gap,
          last_sale_date: lastSaleDate.get(pid) ?? null
        })
      }
    }
    atRisk.sort((a, b) => b.gap - a.gap)
    const atRiskTop = atRisk.slice(0, 20)

    // 6) Top products — by gross profit (accurate, historical cost), keep 20
    type TopRow = {
      product_id: string
      product_name: string
      qty_12m: number
      revenue_12m: number
      gross_profit_12m: number
    }
    const top: TopRow[] = []
    for (const pid of qtyMap.keys()) {
      top.push({
        product_id: pid,
        product_name: nameMap.get(pid) ?? '(unnamed)',
        qty_12m: qtyMap.get(pid) ?? 0,
        revenue_12m: revenueMap.get(pid) ?? 0,
        gross_profit_12m: gpMap.get(pid) ?? 0
      })
    }
    top.sort((a, b) => b.gross_profit_12m - a.gross_profit_12m)
    const topProducts = top.slice(0, 20)

    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty: totalQty12,
        sales_12m_revenue: totalRev12
      },
      atRisk: atRiskTop,
      topProducts
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', {
      message: String(e?.message || e),
      details: String(e?.stack || e)
    })
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
