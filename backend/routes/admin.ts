import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ---------------- Refresh Product Profit Cache ---------------- */
async function handleRefresh(_req: any, res: any) {
  try {
    const before = await supabaseService
      .from('product_profit_cache')
      .select('product_id', { count: 'exact', head: true })

    if (before.error && before.error.code !== 'PGRST116') {
      return res.status(500).json({ error: before.error.message })
    }

    const rpc = await supabaseService.rpc('refresh_product_profit_cache', {})
    if (rpc.error) return res.status(500).json({ error: rpc.error.message })

    const after = await supabaseService
      .from('product_profit_cache')
      .select('product_id', { count: 'exact', head: true })

    const rows = after.count ?? null
    return res.json({ ok: true, rows })
  } catch (e: any) {
    console.error('refresh-gross-profit error:', e)
    return res.status(500).json({ error: e?.message || 'Refresh failed' })
  }
}

router.post('/admin/refresh-gross-profit', handleRefresh)
router.post('/refresh-gross-profit', handleRefresh) // alias

/* ---------------- Refresh At-Risk Products Cache ---------------- */
async function handleRefreshAtRisk(_req: any, res: any) {
  try {
    console.log('[refresh-at-risk] Starting...')
    
    // 1) Fetch ALL products with pagination to avoid Supabase 1000 row limit
    const allProducts = []
    let offset = 0
    const PAGE_SIZE = 1000
    
    while (true) {
      const productsQuery = await supabaseService
        .from('products')
        .select('id, name')
        .range(offset, offset + PAGE_SIZE - 1)
      
      if (productsQuery.error) throw productsQuery.error
      
      const batch = productsQuery.data ?? []
      if (batch.length === 0) break
      
      allProducts.push(...batch)
      
      if (batch.length < PAGE_SIZE) break // Last page
      offset += PAGE_SIZE
    }
    
    console.log(`[refresh-at-risk] Processing ${allProducts.length} products`)
    
    // 2) Calculate for each product (same logic as dashboard)
    const ORDER_COVERAGE_MONTHS = 4
    const weights = Array.from({ length: 12 }, (_, i) => i + 1)
    const wSum = weights.reduce((a, b) => a + b, 0)
    
    // Get last 12 months
    const now = new Date()
    const last12Months = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getUTCFullYear(), now.getUTCMonth() - i, 1)
      const mStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10)
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
      last12Months.push({ start: mStart, end: mEnd })
    }
    
    const atRiskData = []
    const BATCH_SIZE = 50
    
    for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
      const batch = allProducts.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(batch.map(async (product) => {
        try {
          // Get monthly sales for last 12 months
          const monthlyQtys = []
          for (const month of last12Months) {
            const salesRes = await supabaseService
              .from('sales')
              .select('quantity')
              .eq('product_id', product.id)
              .gte('date', month.start)
              .lte('date', month.end)
            
            if (!salesRes.error && salesRes.data) {
              const totalQty = salesRes.data.reduce((sum: number, r: any) => sum + Number(r.quantity ?? 0), 0)
              monthlyQtys.push(totalQty)
            } else {
              monthlyQtys.push(0)
            }
          }
          
          // Calculate weighted MOQ
          const weightedSum = monthlyQtys.reduce((acc, qty, i) => acc + qty * weights[i], 0)
          const weightedAvg = wSum ? weightedSum / wSum : 0
          const weighted_moq = Math.ceil(weightedAvg * ORDER_COVERAGE_MONTHS)
          
          // Get inventory
          const inv = await supabaseService
            .from('inventory_current')
            .select('on_hand, backorder')
            .eq('product_id', product.id)
            .maybeSingle()
          
          const on_hand = Number(inv.data?.on_hand ?? 0)
          const backorder = Number(inv.data?.backorder ?? 0)
          const gap = Math.max(0, weighted_moq - on_hand)
          
          return {
            product_id: product.id,
            product_name: product.name || '',
            on_hand,
            backorder,
            weighted_moq,
            gap
          }
        } catch (e) {
          console.error(`[refresh-at-risk] Error for product ${product.id}:`, e)
          return null
        }
      }))
      
      atRiskData.push(...batchResults.filter(Boolean))
      
      // Small delay to avoid overwhelming the DB
      if (i + BATCH_SIZE < allProducts.length) {
        await new Promise(res => setTimeout(res, 10))
      }
    }
    
    // 3) Clear existing cache by deleting all rows
    // Use .neq() with impossible UUID to match all rows
    const impossibleUUID = '00000000-0000-0000-0000-000000000000'
    const clearRes = await supabaseService
      .from('product_at_risk_cache')
      .delete()
      .neq('id', impossibleUUID)
      
    if (clearRes.error) {
      console.warn('[refresh-at-risk] Clear error (non-fatal):', clearRes.error.message)
    } else {
      console.log(`[refresh-at-risk] Cleared existing cache entries`)
    }
    
    // 4) Insert new data in batches
    let inserted = 0
    for (let i = 0; i < atRiskData.length; i += 100) {
      const batch = atRiskData.slice(i, i + 100)
      const insRes = await supabaseService.from('product_at_risk_cache').insert(batch)
      if (insRes.error) throw insRes.error
      inserted += batch.length
    }
    
    console.log(`[refresh-at-risk] Complete. Inserted ${inserted} products.`)
    
    return res.json({ ok: true, rows: inserted, products_processed: allProducts.length })
  } catch (e: any) {
    console.error('refresh-at-risk error:', e)
    return res.status(500).json({ error: e?.message || 'Refresh failed' })
  }
}

router.post('/admin/refresh-at-risk', handleRefreshAtRisk)
router.post('/refresh-at-risk', handleRefreshAtRisk) // alias

/* ---------------- Wipe All Data ---------------- */
router.post('/admin/wipe-data', async (_req, res) => {
  try {
    // This SQL function will truncate all relevant tables.
    const rpc = await supabaseService.rpc('wipe_all_data', {})
    if (rpc.error) {
      console.error('wipe-all-data error:', rpc.error)
      return res.status(500).json({ error: rpc.error.message })
    }

    return res.json({ ok: true, message: 'All data deleted successfully.' })
  } catch (e: any) {
    console.error('wipe-all-data unhandled:', e)
    return res.status(500).json({ error: e?.message || 'Failed to wipe data' })
  }
})

/* ---------------- Delete Inventory Data Only ---------------- */
router.post('/admin/delete-inventory-data', async (_req, res) => {
  try {
    // Count before deletion
    const invCountBefore = await supabaseService.from('inventory_current').select('product_id', { count: 'exact', head: true })
    const priceCountBefore = await supabaseService.from('product_prices').select('product_id', { count: 'exact', head: true })
    const prodCountBefore = await supabaseService.from('products').select('id', { count: 'exact', head: true })
    
    // Delete inventory_current data - use .neq() with impossible UUID to match all rows
    const impossibleUUID = '00000000-0000-0000-0000-000000000000'
    const invDel = await supabaseService.from('inventory_current').delete().neq('product_id', impossibleUUID)
    if (invDel.error) {
      console.error('delete inventory_current error:', invDel.error)
      return res.status(500).json({ error: invDel.error.message })
    }

    // Delete product_prices data
    const priceDel = await supabaseService.from('product_prices').delete().neq('product_id', impossibleUUID)
    if (priceDel.error) {
      console.error('delete product_prices error:', priceDel.error)
      return res.status(500).json({ error: priceDel.error.message })
    }

    // Also delete products (created by inventory uploads)
    const prodDel = await supabaseService.from('products').delete().neq('id', impossibleUUID)
    if (prodDel.error) {
      console.warn('delete products error (non-fatal):', prodDel.error.message)
    }

    return res.json({ 
      ok: true, 
      message: 'Inventory data, prices, and products deleted successfully.',
      deleted: {
        inventory_rows: invCountBefore.count || 0,
        price_rows: priceCountBefore.count || 0,
        products_rows: prodCountBefore.count || 0
      }
    })
  } catch (e: any) {
    console.error('delete-inventory-data unhandled:', e)
    return res.status(500).json({ error: e?.message || 'Failed to delete inventory data' })
  }
})

/* ---------------- Delete Sales Data Only ---------------- */
router.post('/admin/delete-sales-data', async (_req, res) => {
  try {
    // Count before deletion
    const salesCountBefore = await supabaseService.from('sales').select('id', { count: 'exact', head: true })
    const custCountBefore = await supabaseService.from('customers').select('id', { count: 'exact', head: true })
    
    // Delete sales data - use .neq() with impossible UUID to match all rows
    const impossibleUUID = '00000000-0000-0000-0000-000000000000'
    const salesDel = await supabaseService.from('sales').delete().neq('id', impossibleUUID)
    if (salesDel.error) {
      console.error('delete sales error:', salesDel.error)
      return res.status(500).json({ error: salesDel.error.message })
    }

    // Also delete customers (created by sales uploads)
    const custDel = await supabaseService.from('customers').delete().neq('id', impossibleUUID)
    if (custDel.error) {
      console.warn('delete customers error (non-fatal):', custDel.error.message)
    }

    // Keep products - they may be used in inventory

    return res.json({ 
      ok: true, 
      message: 'Sales data and customers deleted successfully.',
      deleted: {
        sales_rows: salesCountBefore.count || 0,
        customers_rows: custCountBefore.count || 0
      }
    })
  } catch (e: any) {
    console.error('delete-sales-data unhandled:', e)
    return res.status(500).json({ error: e?.message || 'Failed to delete sales data' })
  }
})

export default router
