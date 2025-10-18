import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** ───────────── Date helpers (UTC, month-aligned) ───────────── */
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function monthEndUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0))
}
function last12WindowUTC() {
  const now = new Date()
  const endMonthStart = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const startMonthStart = monthStartUTC(
    endMonthStart.getUTCFullYear(),
    endMonthStart.getUTCMonth() - 11
  )
  const endMonthEnd = monthEndUTC(
    endMonthStart.getUTCFullYear(),
    endMonthStart.getUTCMonth()
  )
  return {
    startISO: startMonthStart.toISOString().slice(0, 10),
    endISO: endMonthEnd.toISOString().slice(0, 10),
  }
}
function last12MonthKeys(): string[] {
  const now = new Date()
  const anchor = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = monthStartUTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i)
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`)
  }
  return out
}

/** NEW: robust UTC month key (aligns with Product page) */
function ymKeyUTCFromDateLike(v: string | Date): string {
  const d = new Date(typeof v === 'string' ? v + 'T00:00:00Z' : v)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/** ───────────── Utils ───────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUUID = (v: any): v is string => typeof v === 'string' && UUID_RE.test(v)
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** ───────────── Types ───────────── */
type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)
const ORDER_COVERAGE_MONTHS = 4  // 4-month coverage for MOQ

/** ───────────── Route ───────────── */
router.get('/dashboard/overview', async (req, res) => {
  try {
    // pagination for At-Risk
    const page = Math.max(1, Number(req.query.page ?? 1))
    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize ?? 20), 200))
    const from = (page - 1) * pageSize
    const to = from + pageSize

    // 1) Totals (counts)
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    // 2) KPI totals (as requested)
    const { startISO, endISO } = last12WindowUTC()

    // Revenue = sum of revenue_12m from product_kpis_12m
    const revQ = await supabaseService.from('product_kpis_12m').select('revenue_12m')
    if (revQ.error) {
      console.error('[dashboard] revenue from product_kpis_12m error:', revQ.error)
      return res.status(500).json({ error: revQ.error.message })
    }
    const sales_12m_revenue = (revQ.data ?? []).reduce(
      (s: number, r: any) => s + Number(r.revenue_12m ?? 0), 0
    )

    // Sales Qty = sum of the last-12 months from v_sales_monthly_total
    const qtyQ = await supabaseService
      .from('v_sales_monthly_total')
      .select('month,total_qty')
      .gte('month', startISO)
      .lte('month', endISO)
    if (qtyQ.error) {
      console.error('[dashboard] qty from v_sales_monthly_total error:', qtyQ.error)
      return res.status(500).json({ error: qtyQ.error.message })
    }
    const sales_12m_qty = (qtyQ.data ?? []).reduce(
      (s: number, r: any) => s + Number(r.total_qty ?? 0), 0
    )

    // 3) Build monthly buckets for At-Risk (UTC-normalized month keys)
    const sQ = await supabaseService
      .from('sales')
      .select('product_id, date, quantity, unit_price')
      .gte('date', startISO)
      .lte('date', endISO)
    if (sQ.error) {
      console.error('[dashboard] sales query (at-risk) error:', sQ.error)
      return res.status(500).json({ error: sQ.error.message })
    }
    const sales = (sQ.data ?? []) as SaleRow[]

    const keys = last12MonthKeys() // ['YYYY-MM-01', ... oldest -> newest]
    const keyIndex = new Map<string, number>()
    keys.forEach((k, i) => keyIndex.set(k, i))

    const perProdMonthly = new Map<string, number[]>() // pid -> [12]
    for (const r of sales) {
      const mk = ymKeyUTCFromDateLike(String(r.date)) // normalize in UTC (fix)
      const idx = keyIndex.get(mk)
      if (idx === undefined) continue
      const pid = String(r.product_id)
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      arr[idx] += Number(r.quantity ?? 0)
      perProdMonthly.set(pid, arr)
    }

    // 4) Inventory now
    const invQ = await supabaseService.from('inventory_current').select('product_id,on_hand')
    if (invQ.error) {
      console.error('[dashboard] inventory_current error:', invQ.error)
      return res.status(500).json({ error: invQ.error.message })
    }
    const onHandMap = new Map<string, number>(
      (invQ.data ?? []).map((r: any) => [String(r.product_id), Number(r.on_hand ?? 0)])
    )

    // 5) Compute At-Risk rows (all, sorted by gap DESC) — same math as Product page
    type AtRiskRow = {
      product_id: string
      on_hand: number
      weighted_moq: number
      gap: number
    }
    const pidSet = new Set<string>([
      ...Array.from(perProdMonthly.keys()),
      ...Array.from(onHandMap.keys()),
    ])
    const atRiskAll: AtRiskRow[] = []
    for (const pid of pidSet) {
      if (!isUUID(pid)) continue
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)

      // weights 1..12 (oldest=1, newest=12)
      let weightedSum = 0
      for (let i = 0; i < 12; i++) weightedSum += arr[i] * (i + 1)
      const weightedAvg = wSum12 ? (weightedSum / wSum12) : 0
      const weighted_moq = Math.ceil(weightedAvg * ORDER_COVERAGE_MONTHS)

      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)
      if (gap > 0) {
        atRiskAll.push({ product_id: pid, on_hand: onHand, weighted_moq, gap })
      }
    }
    atRiskAll.sort((a, b) => b.gap - a.gap)

    const totalAtRisk = atRiskAll.length
    const pageSlice = atRiskAll.slice(from, to)

    // 6) Fetch names ONLY for the current page
    const atRiskIds = pageSlice.map(r => r.product_id).filter(isUUID)
    let nameMap = new Map<string, string>()
    if (atRiskIds.length > 0) {
      for (const part of chunk(atRiskIds, 200)) {
        const nQ = await supabaseService.from('products').select('id,name').in('id', part)
        if (nQ.error) {
          console.error('[dashboard] name lookup (at-risk) error:', nQ.error)
          return res.status(500).json({ error: nQ.error.message })
        }
        for (const p of nQ.data ?? []) {
          nameMap.set(String(p.id), String(p.name ?? ''))
        }
      }
    }
    const atRiskPage = pageSlice.map(r => ({
      product_id: r.product_id,
      product_name: (nameMap.get(r.product_id) || '').trim() || '(unknown product)',
      on_hand: r.on_hand,
      weighted_moq: r.weighted_moq,
      gap: r.gap,
    }))

    // 7) Respond (topProducts removed; kept as [] for backward-compat)
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
      topProducts: [], // deprecated
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
