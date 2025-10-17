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
  const startMonthStart = monthStartUTC(endMonthStart.getUTCFullYear(), endMonthStart.getUTCMonth() - 11)
  const endMonthEnd = monthEndUTC(endMonthStart.getUTCFullYear(), endMonthStart.getUTCMonth())
  return {
    startISO: startMonthStart.toISOString().slice(0, 10),
    endISO: endMonthEnd.toISOString().slice(0, 10)
  }
}
function last12MonthsKeys(): string[] {
  const now = new Date()
  const anchor = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: string[] = []
  for (let i = 11; i >= 0; i--) {
    const d = monthStartUTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i)
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`)
  }
  return out
}
function monthKeyFrom(isoDate: string): string {
  const y = isoDate.slice(0, 4)
  const m = isoDate.slice(5, 7)
  return `${y}-${m}-01`
}

/** simple uuid guard (relaxed, good enough for Postgres uuid cast) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUUID = (v: any) => typeof v === 'string' && UUID_RE.test(v)

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)

/** Types */
type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }
type InvRow  = { product_id: string; on_hand: number | null }

router.get('/dashboard/overview', async (_req, res) => {
  try {
    /** 1) Totals */
    const prodHead = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    if (prodHead.error) return res.status(500).json({ error: prodHead.error.message })
    const productsCount = prodHead.count ?? 0

    const custHead = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    if (custHead.error) return res.status(500).json({ error: custHead.error.message })
    const customersCount = custHead.count ?? 0

    /** 2) Last 12 months sales (exact month window, inclusive) */
    const { startISO, endISO } = last12WindowUTC()
    const sQ = await supabaseService
      .from('sales')
      .select('product_id, date, quantity, unit_price')
      .gte('date', startISO)
      .lte('date', endISO)

    if (sQ.error) {
      console.error('[dashboard] sales query error:', sQ.error)
      return res.status(500).json({ error: sQ.error.message })
    }
    const sales = (sQ.data ?? []) as SaleRow[]

    let salesQty12 = 0
    let salesRevenue12 = 0
    for (const r of sales) {
      const q = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      salesQty12 += q
      salesRevenue12 += q * up
    }

    /** 3) At-Risk of stockout */
    const keys = last12MonthsKeys()
    const idx = new Map<string, number>()
    keys.forEach((k, i) => idx.set(k, i))

    const perProd = new Map<string, number[]>() // pid -> [12]
    for (const r of sales) {
      const k = monthKeyFrom(String(r.date))
      const i = idx.get(k)
      if (i === undefined) continue
      const pid = String(r.product_id)
      const arr = perProd.get(pid) ?? Array(12).fill(0)
      arr[i] += Number(r.quantity ?? 0)
      perProd.set(pid, arr)
    }

    const invQ = await supabaseService.from('inventory_current').select('product_id,on_hand')
    if (invQ.error) {
      console.error('[dashboard] inventory_current error:', invQ.error)
      return res.status(500).json({ error: invQ.error.message })
    }
    const onHandMap = new Map<string, number>((invQ.data ?? []).map((r: any) => [String(r.product_id), Number(r.on_hand ?? 0)]))

    // union of product ids from sales + inventory, and **only valid uuids**
    const pidSet = new Set<string>([
      ...Array.from(perProd.keys()),
      ...Array.from(onHandMap.keys())
    ])
    const pidList = Array.from(pidSet).filter(isUUID)

    // fetch names ONLY for valid UUIDs
    let nameMap = new Map<string, string>()
    if (pidList.length > 0) {
      const nameRes = await supabaseService.from('products').select('id,name').in('id', pidList)
      if (nameRes.error) {
        console.error('[dashboard] products name lookup error:', nameRes.error)
        return res.status(500).json({ error: nameRes.error.message })
      }
      nameMap = new Map((nameRes.data ?? []).map((p: any) => [String(p.id), String(p.name ?? '')]))
    }

    type AtRiskRow = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
    }
    const atRisk: AtRiskRow[] = []
    for (const pid of pidList) {
      const arr = perProd.get(pid) ?? Array(12).fill(0)
      const weightedSum = arr.reduce((acc, q, i) => acc + q * weights12[i], 0)
      const weighted_moq = Math.ceil(wSum12 ? weightedSum / wSum12 : 0)
      const onHand = onHandMap.get(pid) ?? 0
      const gap = Math.max(0, weighted_moq - onHand)
      if (gap > 0) {
        const nm = (nameMap.get(pid) || '').trim()
        atRisk.push({
          product_id: pid,
          product_name: nm || '(unknown product)',
          on_hand: onHand,
          weighted_moq,
          gap
        })
      }
    }
    atRisk.sort((a, b) => b.gap - a.gap)
    const atRiskTop20 = atRisk.slice(0, 20)

    /** 4) Top products — view first, fallback to table; validate ids for name lookup */
    let topProducts: Array<{
      product_id: string
      product_name: string
      qty_12m: number
      revenue_12m: number
      gross_profit_12m: number
    }> = []

    const topView = await supabaseService
      .from('v_product_profit_cache')
      .select('product_id, product_name, qty_12m, revenue_12m, gross_profit_12m')
      .order('gross_profit_12m', { ascending: false })
      .limit(20)

    if (!topView.error) {
      topProducts = (topView.data ?? []).map((r: any) => ({
        product_id: String(r.product_id),
        product_name: String(r.product_name ?? '').trim()
          || (nameMap.get(String(r.product_id)) ?? '(unknown product)'),
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0)
      }))
    } else {
      console.warn('[dashboard] falling back to product_profit_cache table:', topView.error)
      const topTbl = await supabaseService
        .from('product_profit_cache')
        .select('product_id, qty_12m, revenue_12m, gross_profit_12m')
        .order('gross_profit_12m', { ascending: false })
        .limit(20)
      if (topTbl.error) {
        console.error('[dashboard] product_profit_cache fallback error:', topTbl.error)
        return res.status(500).json({ error: topTbl.error.message })
      }

      const ids = (topTbl.data ?? []).map((r: any) => String(r.product_id)).filter(isUUID)
      let localNames = new Map<string, string>()
      if (ids.length > 0) {
        const nQ = await supabaseService.from('products').select('id,name').in('id', ids)
        if (nQ.error) {
          console.error('[dashboard] fallback names lookup error:', nQ.error)
          return res.status(500).json({ error: nQ.error.message })
        }
        localNames = new Map((nQ.data ?? []).map((p: any) => [String(p.id), String(p.name ?? '')]))
      }

      topProducts = (topTbl.data ?? []).map((r: any) => ({
        product_id: String(r.product_id),
        product_name: (localNames.get(String(r.product_id)) || '').trim() || '(unknown product)',
        qty_12m: Number(r.qty_12m ?? 0),
        revenue_12m: Number(r.revenue_12m ?? 0),
        gross_profit_12m: Number(r.gross_profit_12m ?? 0)
      }))
    }

    /** 5) Reply */
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
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
