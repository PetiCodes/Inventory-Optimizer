import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/**
 * POST /api/refresh-gross-profit
 * Rebuilds the 12-month profit cache using accurate “cost at/before sale date”.
 * Optional JSON body: { asOf: 'YYYY-MM-DD' }  // defaults to today (server time)
 */
router.post('/refresh-gross-profit', async (req, res) => {
  try {
    const asOf =
      (typeof req.body?.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.asOf))
        ? req.body.asOf
        : new Date().toISOString().slice(0, 10)

    // Call the SQL function you installed earlier
    const { error } = await supabaseService.rpc('refresh_product_profit_cache', { p_asof: asOf })
    if (error) return res.status(500).json({ error: error.message })

    return res.json({ ok: true, asOf })
  } catch (e: any) {
    console.error('POST /api/refresh-gross-profit error:', e)
    return res.status(500).json({ error: e?.message || 'Server error' })
  }
})

export default router
