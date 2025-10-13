import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware'
import { supabaseService } from '../src/supabase'

const router = Router()

/**
 * GET /api/customers?page=1&pageSize=15
 * Live paginated customers list.
 */
router.get('/customers', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
    const pageSize = Math.max(1, Math.min(parseInt(String(req.query.pageSize ?? '15'), 10) || 15, 200))
    const start = (page - 1) * pageSize
    const end = start + pageSize - 1

    const q = String(req.query.q ?? '').trim()
    let query = supabaseService
      .from('customers')
      .select('id,name', { count: 'exact' })
      .order('name', { ascending: true })
      .range(start, end)

    if (q) query = query.ilike('name', `%${q}%`)

    const { data, error, count } = await query

    if (error) {
      console.error('customers list error:', error)
      return res.status(500).json({ error: error.message })
    }

    return res.json({ page, pageSize, total: count ?? 0, customers: data ?? [] })
  } catch (e: any) {
    console.error('GET /customers error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

/**
 * GET /api/customers/:id/overview
 * {
 *   customer: { id, name },
 *   summary: { total_qty, distinct_products, first_date, last_date },
 *   monthly: [{ month:'YYYY-MM-01', qty }],
 *   products: [{ product_id, product_name, qty }]
 * }
 */
router.get('/customers/:id/overview', requireAuth, async (req, res) => {
  try {
    const customerId = String(req.params.id)

    // Customer basic info
    const cust = await supabaseService.from('customers').select('id,name').eq('id', customerId).single()
    if (cust.error || !cust.data) return res.status(404).json({ error: 'Customer not found' })

    // Summary
    const summary = await supabaseService.rpc('customer_summary', { p_customer_id: customerId })
    if (summary.error) return res.status(500).json({ error: summary.error.message })

    // Monthly timeline
    const monthly = await supabaseService.rpc('customer_monthly_totals', { p_customer_id: customerId })
    if (monthly.error) return res.status(500).json({ error: monthly.error.message })

    // Products totals
    const products = await supabaseService.rpc('customer_products_totals', { p_customer_id: customerId })
    if (products.error) return res.status(500).json({ error: products.error.message })

    return res.json({
      customer: cust.data,
      summary: (summary.data && summary.data[0]) ? {
        total_qty: Number(summary.data[0].total_qty) || 0,
        distinct_products: Number(summary.data[0].distinct_products) || 0,
        first_date: summary.data[0].first_date,
        last_date: summary.data[0].last_date
      } : { total_qty: 0, distinct_products: 0, first_date: null, last_date: null },
      monthly: (monthly.data ?? []).map((r: any) => ({ month: r.month, qty: Number(r.total_qty) || 0 })),
      products: (products.data ?? []).map((r: any) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        qty: Number(r.total_qty) || 0
      }))
    })
  } catch (e: any) {
    console.error('GET /customers/:id/overview error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
