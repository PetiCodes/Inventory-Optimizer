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
function monthKeyFromISO(iso: string): string {
  const y = iso.slice(0, 4)
  const m = iso.slice(5, 7)
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

/** ───────────── Route ───────────── */
router.get('/dashboard/overview', async (_req, res) => {
  try {
    // 1) Totals (counts)
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    // 2) KPI totals (as requested)
    const { startISO, endISO } = last12WindowUTC()

    // Revenue = sum of revenue_12m from product_kpis_12m (assumes one row per product with the latest 12M)
    const revQ = await supabaseService.from('product_kpis_12m').select('revenue_12m')
    if (revQ.error) {
      console.error('[dashboard] revenue from product_kpis_12m error:', revQ.error)
      return res.status(500).json({ error: revQ.error.message })
    }
    const sales_12m_revenue = (revQ.data ?? []).reduce(
      (s: number, r: any) => s + Number(r.revenue_12m ?? 0), 0
    )

    // Sales Qty = sum of the last 12 rows from v_sales_monthly_total in the month window
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

    // 3) Build monthly buckets for At-Risk (use raw sales just for this)
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

    const keys = last12MonthKeys()
    const keyIndex = new Map<string, number>()
    keys.forEach((k, i) => keyIndex.set(k, i))

    const perProdMonthly = new Map<string, number[]>() // pid -> [12]
    for (const r of sales) {
      const mk = monthKeyFromISO(String(r.date))
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

    // 5) Compute At-Risk rows (WITHOUT names)
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
    const atRiskRaw: AtRiskRow[] = []
    for (const pid of pidSet) {
      if (!isUUID(pid)) continue
      const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((sum, q, i) => sum + q * weights12[i], 0)
      const weighted_moq = Math.ceil(wSum12 ? (weightedSum / wSum12) : 0)
      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)
      if (gap > 0) {
        atRiskRaw.push({ product_id: pid, on_hand: onHand, weighted_moq, gap })
      }
    }
    atRiskRaw.sort((a, b) => b.gap - a.gap)
    const atRiskTop20 = atRiskRaw.slice(0, 20)

    // 6) Fetch names ONLY for the At-Risk Top 20
    const atRiskIds = atRiskTop20.map(r => r.product_id).filter(isUUID)
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
    const atRisk = atRiskTop20.map(r => ({
      product_id: r.product_id,
      product_name: (nameMap.get(r.product_id) || '').trim() || '(unknown product)',
      on_hand: r.on_hand,
      weighted_moq: r.weighted_moq,
      gap: r.gap,
    }))

    // 7) Top Products — rank strictly by gross_profit_12m DESC (prefer view)
    let topProducts: Array<{
      product_id: string
      product_name: string
      qty_12m: number
      revenue_12m: number
      gross_profit_12m: number
    }> = []

    const viewQ = await supabaseService
      .from('v_product_profit_cache')
      .select('product_id, product_name, qty_12m, revenue_12m, gross_profit_12m')
      .order('gross_profit_12m', { ascending: false })
      .limit(20)

    if (!viewQ.error) {
      topProducts = (viewQ.data ?? []).map((r: any) => ({
        product_id: String(r.product_id),
        product_name: String(r.product_name ?? '').trim() || '(unknown product)',
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0),
      }))
    } else {
      // Fallback to the table + name lookup (still sorted by GP DESC)
      console.warn('[dashboard] falling back to product_profit_cache table:', viewQ.error)
      const tblQ = await supabaseService
        .from('product_profit_cache')
        .select('product_id, qty_12m, revenue_12m, gross_profit_12m')
        .order('gross_profit_12m', { ascending: false })
        .limit(20)
      if (tblQ.error) {
        console.error('[dashboard] product_profit_cache fallback error:', tblQ.error)
        return res.status(500).json({ error: tblQ.error.message })
      }

      const ids = (tblQ.data ?? []).map((r: any) => String(r.product_id)).filter(isUUID)
      let topNameMap = new Map<string, string>()
      if (ids.length > 0) {
        for (const part of chunk(ids, 200)) {
          const nQ = await supabaseService.from('products').select('id,name').in('id', part)
          if (nQ.error) {
            console.error('[dashboard] name lookup (top) error:', nQ.error)
            return res.status(500).json({ error: nQ.error.message })
          }
          for (const p of nQ.data ?? []) {
            topNameMap.set(String(p.id), String(p.name ?? ''))
          }
        }
      }

      topProducts = (tblQ.data ?? []).map((r: any) => ({
        product_id: String(r.product_id),
        product_name: (topNameMap.get(String(r.product_id)) || '').trim() || '(unknown product)',
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0),
      }))
    }

    // 8) Respond
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty,
        sales_12m_revenue,
      },
      atRisk,
      topProducts,
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
