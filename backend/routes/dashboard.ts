import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** ───────────── Date helpers (same as products.ts) ───────────── */
function monthStartUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0, 1))
}
function monthEndUTC(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0))
}
function lastNMonthsScaffold(n: number) {
  const now = new Date()
  const anchorStart = monthStartUTC(now.getUTCFullYear(), now.getUTCMonth())
  const out: { y: number; m0: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = monthStartUTC(anchorStart.getUTCFullYear(), anchorStart.getUTCMonth() - i)
    out.push({ y: d.getUTCFullYear(), m0: d.getUTCMonth() })
  }
  return out
}

/** ───────────── Utils ───────────── */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUUID = (v: any): v is string => typeof v === 'string' && UUID_RE.test(v)
function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** ───────────── MOQ constants (match products.ts) ───────────── */
const ORDER_COVERAGE_MONTHS = 4
const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a, b) => a + b, 0)

/** ───────────── Types ───────────── */
type SaleRow = { product_id: string; quantity: number; unit_price?: number | null }

/** ───────────── Route ───────────── */
router.get('/dashboard/overview', async (req, res) => {
  try {
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

    // 2) KPIs - Use correct views for each metric
    let sales_12m_qty = 0
    
    // Sales Qty (12m): Keep original logic using v_sales_monthly_total
    {
      const qtyQ = await supabaseService
        .from('v_sales_monthly_total')
        .select('month,total_qty')
        .order('month', { ascending: false })
        .limit(12)
      if (qtyQ.error) return res.status(500).json({ error: qtyQ.error.message })
      sales_12m_qty = (qtyQ.data ?? []).reduce((s: number, r: any) => s + Number(r.total_qty ?? 0), 0)
    }

      // Revenue = sum of revenue_12m from product_kpis_12m (handle pagination to get all rows)
      let sales_12m_revenue = 0
      {
        const PAGE = 1000
        let offset = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const revQ = await supabaseService
            .from('product_kpis_12m')
            .select('revenue_12m')
            .range(offset, offset + PAGE - 1)
          
          if (revQ.error) {
            console.error('[dashboard] revenue from product_kpis_12m error:', revQ.error)
            return res.status(500).json({ error: revQ.error.message })
          }
          
          const rows = revQ.data ?? []
          if (rows.length === 0) break
          
          // Sum revenue from this batch
          const batchRevenue = rows.reduce((s: number, r: any) => s + Number(r.revenue_12m ?? 0), 0)
          sales_12m_revenue += batchRevenue
          
          if (rows.length < PAGE) break
          offset += PAGE
        }
      }

    // 3) Per-product monthly aggregation (for MOQ calc identical to products.ts)
    const perProdMonthly = new Map<string, number[]>() // pid -> [12]
    {
      // Define s12 for the monthly aggregation
      const s12 = lastNMonthsScaffold(12)
      const PAGE = 1000
      for (let i = 0; i < 12; i++) {
        const mStart = monthStartUTC(s12[i].y, s12[i].m0).toISOString().slice(0, 10)
        const mEnd = monthEndUTC(s12[i].y, s12[i].m0).toISOString().slice(0, 10)

        let offset = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await supabaseService
            .from('sales')
            .select('product_id,quantity')
            .gte('date', mStart)
            .lte('date', mEnd)
            .range(offset, offset + PAGE - 1)

          if (batch.error) return res.status(500).json({ error: batch.error.message })
          const rows = (batch.data ?? []) as { product_id: string; quantity: number }[]
          if (rows.length === 0) break

          for (const r of rows) {
            const pid = String(r.product_id)
            if (!isUUID(pid)) continue
            const arr = perProdMonthly.get(pid) ?? Array(12).fill(0)
            arr[i] += Number(r.quantity ?? 0)
            perProdMonthly.set(pid, arr)
          }
          if (rows.length < PAGE) break
          offset += PAGE
        }
      }
    }

    // 4) On hand + backorder - we'll fetch this per product in the at-risk section for accuracy
    const onHandMap = new Map<string, number>()
    const backorderMap = new Map<string, number>()

    // 5) At-Risk products section
    let atRiskProducts: any[] = []
    {
      try {
        // Get all products with names first
        const { data: allProducts, error: productsError } = await supabaseService
          .from('products')
          .select('id,name')
          .order('name', { ascending: true })

        if (productsError) {
          console.warn('[at-risk] Products query error:', productsError.message)
        } else if (allProducts && allProducts.length > 0) {
          // Process products in batches to balance performance and accuracy
          const BATCH_SIZE = 100
          const productBatches = []
          for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
            productBatches.push(allProducts.slice(i, i + BATCH_SIZE))
          }

          atRiskProducts = []
          
          for (const batch of productBatches) {
            const batchResults = await Promise.all(batch.map(async (product) => {
              // Get sales data if available, otherwise use zeros
              const monthlyData = perProdMonthly.get(product.id) || Array(12).fill(0)
              
              // Calculate weighted average from the 12 months of data
              const weights = Array.from({ length: 12 }, (_, i) => i + 1)
              const wSum = weights.reduce((a, b) => a + b, 0)
              const weightedSum = monthlyData.reduce((acc, qty, i) => acc + qty * weights[i], 0)
              const weightedAvg = wSum ? weightedSum / wSum : 0
              const weighted_moq = Math.ceil(weightedAvg * ORDER_COVERAGE_MONTHS)
              
              // Get on-hand from inventory_current using the same method as individual product pages
              let on_hand = 0
              try {
                const inv = await supabaseService
                  .from('inventory_current')
                  .select('on_hand, backorder')
                  .eq('product_id', product.id)
                  .maybeSingle()
                
                if (!inv.error && inv.data) {
                  on_hand = Number(inv.data.on_hand ?? 0)
                }
              } catch (e) {
                // Silent fail for individual products
              }
              
              const gap = Math.max(0, weighted_moq - on_hand)

              return {
                product_id: product.id,
                product_name: product.name || `Product ${product.id.slice(0, 8)}...`,
                on_hand,
                weighted_moq,
                gap
              }
            }))
            
            atRiskProducts.push(...batchResults)
          }

          // Sort by gap (highest first) - show ALL products, not just top 20
          atRiskProducts.sort((a, b) => b.gap - a.gap)
        }
        
      } catch (e: any) {
        console.error('[at-risk] Error:', e)
        // Fallback: return empty array if there's an error
        atRiskProducts = []
      }
    }

    // 6) Response
    return res.json({
      totals: {
        products: productsCount,
        customers: customersCount,
        sales_12m_qty,
        sales_12m_revenue,
      },
      atRisk: atRiskProducts
    })
  } catch (e: any) {
    console.error('GET /dashboard/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
