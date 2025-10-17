import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/**
 * Triggers the SQL function refresh_product_profit_cache() you created.
 * We expose TWO paths so either will work:
 *   POST /api/admin/refresh-gross-profit   (preferred)
 *   POST /api/refresh-gross-profit         (legacy/backup)
 */
async function handleRefresh(_req: any, res: any) {
  try {
    // (Optional) get a count to return something meaningful
    const before = await supabaseService
      .from('product_profit_cache')
      .select('product_id', { count: 'exact', head: true })

    if (before.error && before.error.code !== 'PGRST116') {
      // PGRST116 = relation not found; ignore so we can still run the function which will create/replace rows
      return res.status(500).json({ error: before.error.message })
    }

    const rpc = await supabaseService.rpc('refresh_product_profit_cache', {})
    if (rpc.error) {
      return res.status(500).json({ error: rpc.error.message })
    }

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

router.post('/admin/refresh-gross-profit', handleRefresh) // preferred
router.post('/refresh-gross-profit', handleRefresh)       // alias

export default router
