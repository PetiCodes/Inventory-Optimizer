import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware'
import { supabaseService } from '../src/supabase'

const router = Router()

/**
 * GET /api/dashboard/summary
 * Returns live KPIs for dashboard
 */
router.get('/dashboard/summary', requireAuth, async (_req, res) => {
  try {
    // Total products
    const prod = await supabaseService.from('products').select('id', { count: 'exact', head: true })

    // Total sales (sum of quantities)
    const salesSum = await supabaseService
      .from('sales')
      .select('quantity')
    const totalSalesQty = salesSum.error
      ? 0
      : salesSum.data?.reduce((acc, row) => acc + Number(row.quantity || 0), 0) ?? 0

    // Unique customers
    // replace the Unique customers block with:
    const custCount = await supabaseService
        .from('customers')
        .select('id', { count: 'exact', head: true })
    const uniqueCustomers = custCount.count ?? 0


    // Latest month total
    const latestMonth = await supabaseService.rpc('latest_month_total')
    const latestQty = latestMonth.error ? 0 : Number(latestMonth.data ?? 0)

    return res.json({
      totalProducts: prod.count ?? 0,
      totalSalesQty,
      uniqueCustomers,
      latestMonthQty: latestQty
    })
  } catch (e: any) {
    console.error('dashboard summary error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
