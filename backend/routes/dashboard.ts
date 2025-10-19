import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ───────────── Date helpers (identical behavior to products.ts) ───────────── */
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function monthEndUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0)) // last day of month
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

/* ───────────── Utils ───────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUUID = (v: any): v is string => typeof v === 'string' && UUID_RE.test(v)
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/* ───────────── Constants (same as product page) ───────────── */
const ORDER_COVERAGE_MONTHS = 4
const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)

/* ───────────── Types ───────────── */
type SaleRow = { product_id: string; date: string; quantity: number }

/* ───────────── Route ───────────── */
router.get('/dashboard/overview', async (req, res) => {
  try {
    // pagination for At-Risk table in the UI
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize ?? 20), 200))
    const from = (page - 1) * pageSize
    const to = from + pageSize

    // 1) Totals
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    // 2) KPI totals (last 12 months window identical to products.ts)
    const s12 = lastNMonthsScaffold(12)
    const startISO = monthStartUTC(s12[0].y, s12[0].m0).toISOString().slice(0, 10)
    const endISO = monthEndUTC(s12[s12.length - 1].y, s12[s12.length - 1].m0).toISOString().slice(0, 10)

    const revQ = await supabaseService.from('product_kpis_12m').select('revenue_12m')
    if (revQ.error) return res.status(500).json({ error: revQ.error.message })
    const sales_12m_revenue = (revQ.data ?? []).reduce(
      (s: number, r: any) => s + Number(r.revenue_12m ?? 0), 0
    )

    const qtyQ = await supabaseService
      .from('v_sales_monthly_total')
      .select('month,total_qty')
      .gte('month', startISO)
      .lte('month', endISO)
    if (qtyQ.error) return res.status(500).json({ error: qtyQ.error.message })
    const sales_12m_qty = (qtyQ.data ?? []).reduce(
      (s: number, r: any) => s + Number(r.total_qty ?? 0), 0
    )

    // 3) FETCH *ALL* sales in window (paginate; default limit ~1k misses many rows)
    const perProdMonthly = new Map<string, number[]>() // pid -> [12]
    const monthKeys = s12.map(x => `${x.key}-01`)
    const keyIndex = new Map(monthKeys.map((k, i) => [k, i]))

    const SALES_PAGE = 10000
    let offset = 0
    while (true) {
      const salesBatch = await supabaseService
        .from('sales')
        .select('product_id, date, quantity')
        .gte('date', startISO)
        .lte('date', endISO)
        .order('date', { ascending: true })
        .range(offset, offset + SALES_PAGE - 1)

      if (salesBatch.error) {
        return res.status(500).json({ error: salesBatch.error.message })
      }

      for (const r of (salesBatch.data ?? []) as SaleRow[]) {
        const d = new Date(String(r.date) + 'T00:00:00Z')
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
        const idx = keyIndex.get(key)
        if (idx === undefined) continue
        const pid = String(r.product_id)
        const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
        arr[idx] += Number(r.quantity ?? 0)
        perProdMonthly.set(pid, arr)
      }

      // stop when we read fewer than the page size
      const count = salesBatch.data?.length ?? 0
      if (count < SALES_PAGE) break
      offset += SALES_PAGE
    }

    // 4) Inventory snapshot
    const invQ = await supabaseService.from('inventory_current').select('product_id,on_hand')
    if (invQ.error) return res.status(500).json({ error: invQ.error.message })
    const onHandMap = new Map<string, number>(
      (invQ.data ?? []).map((r: any) => [String(r.product_id), Number(r.on_hand ?? 0)])
    )

    // 5) Compute At-Risk using the SAME MOQ formula as products.ts
    type AtRiskRow = { product_id: string; on_hand: number; weighted_moq: number; gap: number }
    const pidSet = new Set<string>([
      ...Array.from(perProdMonthly.keys()),
      ...Array.from(onHandMap.keys()),
    ])

    const atRiskAll: AtRiskRow[] = []
    for (const pid of pidSet) {
      if (!isUUID(pid)) continue
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((sum, q, i) => sum + q * (i + 1), 0) // oldest=1 … newest=12
      const weightedAvg12 = wSum12 ? (weightedSum / wSum12) : 0
      const weighted_moq = Math.ceil(weightedAvg12 * ORDER_COVERAGE_MONTHS)
      const on_hand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - on_hand)
      if (gap > 0) {
        atRiskAll.push({ product_id: pid, on_hand, weighted_moq, gap })
      }
    }

    atRiskAll.sort((a, b) => b.gap - a.gap)
    const totalAtRisk = atRiskAll.length
    const pageSlice = atRiskAll.slice(from, to)

    // 6) Name lookup for current page
    const atRiskIds = pageSlice.map(r => r.product_id).filter(isUUID)
    let nameMap = new Map<string, string>()
    if (atRiskIds.length > 0) {
      for (const part of chunk(atRiskIds, 200)) {
        const nQ = await supabaseService.from('products').select('id,name').in('id', part)
        if (nQ.error) return res.status(500).json({ error: nQ.error.message })
        for (const p of nQ.data ?? []) nameMap.set(String(p.id), String(p.name ?? ''))
      }
    }

    const atRiskPage = pageSlice.map(r => ({
      product_id: r.product_id,
      product_name: (nameMap.get(r.product_id) || '').trim() || '(unknown product)',
      on_hand: r.on_hand,
      weighted_moq: r.weighted_moq,
      gap: r.gap,
    }))

    // 7) Response
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty,
        sales_12m_revenue,
      },
      atRisk: {
        page,
        pageSize,
        total: totalAtRisk,
        pages: Math.max(1, Math.ceil(totalAtRisk / pageSize)),
        items: atRiskPage,
      },
      topProducts: [], // kept for backward-compat
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
