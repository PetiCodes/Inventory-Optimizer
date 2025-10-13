import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware'
import { supabaseService } from '../src/supabase'

const router = Router()

/**
 * GET /api/analysis/sales-summary?limit=20
 * Returns:
 * {
 *   monthlyTotals: [{ month: '2024-01-01', total_quantity: 1234 }, ...],
 *   topProducts:   [{ product_id, product_name, total_quantity }, ...]
 * }
 */
router.get('/analysis/sales-summary', requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 20), 200))

    // Monthly totals (across all products)
    const monthly = await supabaseService
      .from('v_sales_monthly_total')
      .select('month,total_quantity')
      .order('month', { ascending: true })

    if (monthly.error) {
      console.error('monthly totals error:', monthly.error)
      return res.status(500).json({ error: monthly.error.message })
    }

    // Top products by total quantity
    const prod = await supabaseService
      .from('v_sales_by_product')
      .select('product_id,product_name,total_quantity')
      .order('total_quantity', { ascending: false })
      .limit(limit)

    if (prod.error) {
      console.error('top products error:', prod.error)
      return res.status(500).json({ error: prod.error.message })
    }

    return res.json({
      monthlyTotals: monthly.data ?? [],
      topProducts: prod.data ?? []
    })
  } catch (e: any) {
    console.error('GET /analysis/sales-summary error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
