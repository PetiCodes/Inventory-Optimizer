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

export default router
