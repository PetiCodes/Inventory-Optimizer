import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/** Helper to fetch all products with pagination */
async function fetchAllProductsData(orderBy: 'gross_profit_12m' | 'product_name' = 'product_name', ascending: boolean = true) {
  const pageSize = 1000
  let from = 0
  let all: any[] = []

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1
    let builder = supabaseService
      .from('v_product_profit_cache')
      .select(`
        product_id, 
        product_name, 
        qty_12m, 
        revenue_12m, 
        gross_profit_12m,
        inventory_current(on_hand)
      `)
      .range(from, to)

    if (orderBy === 'gross_profit_12m') {
      builder = builder.order('gross_profit_12m', { ascending })
    } else {
      builder = builder.order('product_name', { ascending })
    }

    const { data, error } = await builder
    if (error) throw error

    const batch = (data ?? []).map((r: any) => ({
      id: String(r.product_id),
      name: String(r.product_name ?? '').trim() || '(unknown product)',
      qty_12m: Number(r.qty_12m ?? 0),
      revenue_12m: Number(r.revenue_12m ?? 0),
      gross_profit_12m: Number(r.gross_profit_12m ?? 0),
      on_hand: Number(r.inventory_current?.on_hand ?? 0),
    }))

    all = all.concat(batch)
    if (batch.length < pageSize) break
    from += pageSize
    await new Promise(res => setTimeout(res, 10)) // small delay to avoid overwhelming the DB
  }
  return all
}

/** Helper to fetch all at-risk products */
async function fetchAllAtRiskProducts() {
  const pageSize = 1000
  let from = 0
  let all: any[] = []

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1
    const { data, error } = await supabaseService
      .from('product_at_risk_cache')
      .select('product_id, product_name, on_hand, weighted_moq, gap')
      .order('gap', { ascending: false })
      .range(from, to)

    if (error) throw error

    const batch = (data ?? []).map((r: any) => ({
      id: String(r.product_id),
      name: String(r.product_name ?? '').trim() || '(unknown product)',
      on_hand: Number(r.on_hand ?? 0),
      weighted_moq: Number(r.weighted_moq ?? 0),
      gap: Number(r.gap ?? 0),
    }))

    all = all.concat(batch)
    if (batch.length < pageSize) break
    from += pageSize
    await new Promise(res => setTimeout(res, 10))
  }
  return all
}

/** GET /api/export/all-products */
router.get('/export/all-products', async (req, res) => {
  try {
    const products = await fetchAllProductsData('product_name', true)
    return res.json({ items: products })
  } catch (e: any) {
    console.error('GET /export/all-products error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/** GET /api/export/best-products */
router.get('/export/best-products', async (req, res) => {
  try {
    const products = await fetchAllProductsData('gross_profit_12m', false) // descending = best first
    return res.json({ items: products })
  } catch (e: any) {
    console.error('GET /export/best-products error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/** GET /api/export/worst-products */
router.get('/export/worst-products', async (req, res) => {
  try {
    const products = await fetchAllProductsData('gross_profit_12m', true) // ascending = worst first
    return res.json({ items: products })
  } catch (e: any) {
    console.error('GET /export/worst-products error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/** GET /api/export/products-at-risk */
router.get('/export/products-at-risk', async (req, res) => {
  try {
    const products = await fetchAllAtRiskProducts()
    return res.json({ items: products })
  } catch (e: any) {
    console.error('GET /export/products-at-risk error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router

