import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** ---------- helpers ---------- */
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

/** Accept any Supabase query builder, await it, and unwrap {data,error} safely */
async function safeQ<T>(q: any, label: string): Promise<{ data: T | null; error?: string }> {
  try {
    const { data, error } = await q
    if (error) {
      console.error(`[dashboard] ${label} error:`, error)
      return { data: null, error: String(error.message || error) }
    }
    return { data: (data ?? null) as T | null }
  } catch (e: any) {
    console.error(`[dashboard] ${label} exception:`, e)
    return { data: null, error: String(e?.message || e) }
  }
}

router.get('/dashboard/overview', async (_req, res) => {
  try {
    const months = lastNMonthsUTC(12)
    const start12 = months[0]

    /** 1) Totals */
    let productsCount = 0
    {
      const head = await supabaseService.from('products').select('id', { count: 'exact', head: true })
      if (!head.error) productsCount = head.count ?? 0
      else {
        const all = await supabaseService.from('products').select('id', { count: 'exact' })
        if (!all.error) productsCount = all.count ?? 0
      }
    }

    let customersCount = 0
    {
      const head = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
      if (!head.error) customersCount = head.count ?? 0
      else {
        const all = await supabaseService.from('customers').select('id', { count: 'exact' })
        if (!all.error) customersCount = all.count ?? 0
      }
    }

    /** 2) Sales (last 12 months) */
    type SaleRow = { product_id: string; date: string; quantity: number; unit_price: number | null }
    const sales12 = await safeQ<SaleRow[]>(
      supabaseService.from('sales').select('product_id, date, quantity, unit_price').gte('date', start12),
      'sales last12'
    )
    const salesRows: SaleRow[] = Array.isArray(sales12.data) ? sales12.data : []

    let salesQty12 = 0
    let salesRevenue12 = 0
    for (const r of salesRows) {
      const q = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      salesQty12 += q
      salesRevenue12 += q * up
    }

    /** 3) Current unit cost (view may not exist in some envs) */
    type CostRow = { product_id: string; unit_cost: number | null }
    const costNow = await safeQ<CostRow[]>(
      supabaseService.from('v_product_current_price').select('product_id, unit_cost'),
      'v_product_current_price'
    )
    const costMap = new Map<string, number>()
    if (Array.isArray(costNow.data)) {
      for (const r of costNow.data) costMap.set(String(r.product_id), Number(r.unit_cost ?? 0))
    } else {
      console.warn('[dashboard] v_product_current_price not available; assuming unit_cost=0')
    }

    /** 4) Inventory on hand */
    type InvRow = { product_id: string; on_hand: number | null }
    const inv = await safeQ<InvRow[]>(
      supabaseService.from('inventory_current').select('product_id, on_hand'),
      'inventory_current'
    )
    const onHandMap = new Map<string, number>()
    if (Array.isArray(inv.data)) {
      for (const r of inv.data) onHandMap.set(String(r.product_id), Number(r.on_hand ?? 0))
    }

    /** 5) Per-product monthly buckets & last sale date */
    const monthIndex = new Map<string, number>()
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

      const d = String(r.date ?? '')
      const prev = lastSaleDate.get(pid)
      if (!prev || d > prev) lastSaleDate.set(pid, d)
    }

    /** 6) Aggregates for top-products */
    const aggQty = new Map<string, number>()
    const aggRevenue = new Map<string, number>()
    for (const r of salesRows) {
      const pid = String(r.product_id)
      const q = Number(r.quantity ?? 0)
      const up = Number(r.unit_price ?? 0)
      aggQty.set(pid, (aggQty.get(pid) ?? 0) + q)
      aggRevenue.set(pid, (aggRevenue.get(pid) ?? 0) + q * up)
    }

    /** 7) Product ids actually used (sales or inventory) */
    const productIds = new Set<string>([
      ...Array.from(onHandMap.keys()),
      ...Array.from(perProdMonthly.keys()),
      ...Array.from(aggQty.keys()),
    ])

    /** 8) Fetch names for those ids in batches */
    const nameMap = new Map<string, string>()
    if (productIds.size > 0) {
      const idList = Array.from(productIds)
      for (let i = 0; i < idList.length; i += 900) {
        const part = idList.slice(i, i + 900)
        const namesRes = await safeQ<{ id: string; name: string | null }[]>(
          supabaseService.from('products').select('id,name').in('id', part),
          `products names batch ${i / 900}`
        )
        if (Array.isArray(namesRes.data)) {
          for (const row of namesRes.data) {
            const nm = String(row.name ?? '').trim()
            nameMap.set(String(row.id), nm || '(unnamed product)')
          }
        }
      }
    }

    /** 9) Build At-Risk list */
    type AtRiskRow = {
      product_id: string
      product_name: string
      on_hand: number
      weighted_moq: number
      gap: number
      last_sale_date: string | null
    }
    const atRiskAll: AtRiskRow[] = []

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

    // Sort by gap desc and keep Top 20
    let atRisk = atRiskAll.sort((a, b) => b.gap - a.gap).slice(0, 20)

    /** 10) Top products */
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
    let topProducts = topCandidates.slice(0, 20)

    /** 11) SECOND-CHANCE NAME FETCH (fixes “(unnamed product)” on UI) */
    const missingForAtRisk = atRisk.map(r => r.product_id).filter(id => !nameMap.has(id))
    const missingForTop = topProducts.map(r => r.product_id).filter(id => !nameMap.has(id))
    const missing = Array.from(new Set([...missingForAtRisk, ...missingForTop]))
    if (missing.length > 0) {
      const missRes = await safeQ<{ id: string; name: string | null }[]>(
        supabaseService.from('products').select('id,name').in('id', missing),
        'products names (2nd pass)'
      )
      if (Array.isArray(missRes.data)) {
        for (const row of missRes.data) {
          const nm = String(row.name ?? '').trim()
          if (nm) nameMap.set(String(row.id), nm)
        }
      }
      // Apply updated names
      atRisk = atRisk.map(r => ({ ...r, product_name: nameMap.get(r.product_id) ?? r.product_name }))
      topProducts = topProducts.map(r => ({ ...r, product_name: nameMap.get(r.product_id) ?? r.product_name }))
    }

    /** 12) Respond */
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
    console.error('GET /dashboard/overview fatal error:', e)
    // Return a valid shape so UI stays up
    return res.status(200).json({
      totals: { products: 0, customers: 0, sales_12m_qty: 0, sales_12m_revenue: 0 },
      atRisk: [],
      topProducts: [],
      warning: 'Partial/empty data due to server error'
    })
  }
})

export default router
