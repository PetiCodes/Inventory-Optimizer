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

    // 3) At-Risk products section - Use cached data for fast retrieval
    let atRiskProducts: any[] = []
    {
      try {
        // Try to fetch from cache first
        const cacheRes = await supabaseService
          .from('product_at_risk_cache')
          .select('product_id, product_name, on_hand, backorder, weighted_moq, gap')
          .order('gap', { ascending: false })
        
        if (!cacheRes.error && cacheRes.data && cacheRes.data.length > 0) {
          // Use cached data
          atRiskProducts = cacheRes.data.map(r => ({
            product_id: r.product_id,
            product_name: r.product_name,
            on_hand: r.on_hand,
            weighted_moq: r.weighted_moq,
            gap: r.gap
          }))
        } else {
          // Fallback: calculate on-the-fly if cache is missing (for backwards compatibility)
          console.warn('[at-risk] Cache not found, calculating on-the-fly...')
          
          const { data: allProducts } = await supabaseService
            .from('products')
            .select('id,name')
            .order('name', { ascending: true })

          if (allProducts && allProducts.length > 0) {
            const BATCH_SIZE = 100
            for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
              const batch = allProducts.slice(i, i + BATCH_SIZE)
              const batchResults = await Promise.all(batch.map(async (product) => {
                let on_hand = 0
                try {
                  const inv = await supabaseService
                    .from('inventory_current')
                    .select('on_hand')
                    .eq('product_id', product.id)
                    .maybeSingle()
                  
                  if (!inv.error && inv.data) {
                    on_hand = Number(inv.data.on_hand ?? 0)
                  }
                } catch (e) {}

                return {
                  product_id: product.id,
                  product_name: product.name || `Product ${product.id.slice(0, 8)}...`,
                  on_hand,
                  weighted_moq: 0,
                  gap: 0
                }
              }))
              
              atRiskProducts.push(...batchResults)
            }
          }
        }
        
      } catch (e: any) {
        console.error('[at-risk] Error:', e)
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
