import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
})

const norm = (s: any) => String(s ?? '').replace(/^\uFEFF/, '').trim()
const stripCode = (name: string) => name.replace(/^\s*\[[^\]]+\]\s*/, '').trim()

function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let s = String(input).trim()
  if (s === '') return null
  if (/,/.test(s) && !/\.\d+$/.test(s) && /,\d+$/.test(s)) {
    s = s.replace(/\./g, '')   // thousands sep
    s = s.replace(',', '.')    // decimal sep
  } else {
    s = s.replace(/[, ]/g, '') // remove commas/spaces thousands
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type CleanRow = {
  input_name: string
  on_hand: number
  backorder: number
  unit_cost: number | null
  unit_price: number | null
}

const today = () => new Date().toISOString().slice(0, 10)
const nowISO = () => new Date().toISOString()

const chunk = <T,>(arr: T[], size = 500) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, k) => arr.slice(k * size, (k + 1) * size))

/**
 * Expected columns (flexible labels/case):
 *  - Name (or Product / Product Name)
 *  - Quantity On Hand (or On Hand / Stock / Quantity / Qty on Hand)
 *  - Cost (or Unit Cost / Purchase Cost / Cost Price)
 *  - Sales Price (Current) (or Price / Unit Price / Selling Price)
 *
 * Matching:
 *  - Try exact catalog name first.
 *  - Then try by ignoring a leading "[ ... ]" code on either side.
 *  - If still no match -> reject row (do NOT create products).
 *
 * Dedupe:
 *  - If multiple rows map to the same product_id, we SUM on_hand/backorder
 *    and keep the last non-null unit_cost / unit_price (per product) to avoid
 *    "ON CONFLICT … cannot affect row a second time".
 */
router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File is required (field "file")' })

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) return res.status(400).json({ error: 'No sheet found in file' })

    const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
    if (!aoa?.length) return res.status(400).json({ error: 'Empty sheet' })

    const headers = (aoa[0] ?? []).map(h => norm(h))
    const lower = headers.map(h => h.toLowerCase())

    const idx = {
      name:   lower.findIndex(h => ['name','product','product name'].includes(h)),
      onhand: lower.findIndex(h => ['quantity on hand','on hand','qty on hand','stock','quantity'].includes(h)),
      cost:   lower.findIndex(h => ['cost','unit cost','purchase cost','cost price'].includes(h)),
      price:  lower.findIndex(h => ['sales price (current)','sales price','price','unit price','selling price'].includes(h)),
    }

    if (idx.name === -1 || idx.onhand === -1) {
      return res.status(400).json({
        error: 'Missing required columns: Name/Product and Quantity On Hand/On Hand',
        received: headers
      })
    }

    const body = aoa.slice(1).filter(r => r && r.some(c => String(c ?? '').trim() !== ''))
    if (!body.length) return res.status(400).json({ error: 'No data rows' })

    const clean: CleanRow[] = []
    const rejected: { row: number; reason: string; name?: string }[] = []

    for (let i = 0; i < body.length; i++) {
      const r = body[i]
      const rowNum = i + 2

      const name  = norm(r[idx.name])
      const onH   = parseNumber(r[idx.onhand])
      const cost  = idx.cost !== -1 ? parseNumber(r[idx.cost]) : null
      const price = idx.price !== -1 ? parseNumber(r[idx.price]) : null

      if (!name)         { rejected.push({ row: rowNum, reason: 'Missing Name' }); continue }
      if (onH === null)  { rejected.push({ row: rowNum, reason: 'Invalid Quantity On Hand', name }); continue }

      let on_hand = onH
      let backorder = 0
      if (on_hand < 0) { backorder = Math.abs(on_hand); on_hand = 0 }

      clean.push({
        input_name: name,
        on_hand,
        backorder,
        unit_cost: cost,
        unit_price: price
      })
    }

    if (!clean.length) return res.status(400).json({ error: 'No valid rows', rejected })

    // Fetch all existing products and build match maps
    const allSel = await supabaseService.from('products').select('id,name').limit(100000)
    if (allSel.error) return res.status(500).json({ error: allSel.error.message })
    const all = allSel.data ?? []

    const idByExact = new Map(all.map(p => [p.name, p.id]))
    const idByNormalized = new Map<string, string>()
    for (const p of all) {
      const n = stripCode(p.name)
      if (!idByNormalized.has(n)) idByNormalized.set(n, p.id)
    }

    // Match rows to product_id
    type Matched = CleanRow & { product_id: string }
    const matched: Matched[] = []
    for (let i = 0; i < clean.length; i++) {
      const row = clean[i]
      const exact = idByExact.get(row.input_name)
      const byCatalogNorm = idByNormalized.get(row.input_name)         // catalog stored without code
      const byUploadNorm  = idByNormalized.get(stripCode(row.input_name)) // upload provided without code

      const product_id = exact ?? byCatalogNorm ?? byUploadNorm
      if (!product_id) {
        rejected.push({ row: i + 2, reason: 'No matching product in catalog (by exact or bracket-stripped name)', name: row.input_name })
        continue
      }
      matched.push({ ...row, product_id })
    }

    if (matched.length === 0) {
      return res.status(400).json({ error: 'No rows matched existing products', rejected })
    }

    // ── DEDUPE/AGGREGATE PER PRODUCT ─────────────────────────────────────────────
    // inventory_current: sum on_hand/backorder per product_id
    const invAgg = new Map<string, { product_id: string; on_hand: number; backorder: number; updated_at: string }>()
    // product_prices: keep last non-null cost/price per product_id (for today)
    const priceAgg = new Map<string, { product_id: string; unit_cost: number; unit_price: number; effective_date: string }>()

    for (const row of matched) {
      // Inventory aggregation (SUM)
      const invPrev = invAgg.get(row.product_id)
      if (!invPrev) {
        invAgg.set(row.product_id, {
          product_id: row.product_id,
          on_hand: row.on_hand,
          backorder: row.backorder,
          updated_at: nowISO()
        })
      } else {
        invPrev.on_hand += row.on_hand
        invPrev.backorder += row.backorder
      }

      // Price aggregation (last non-null wins)
      const prPrev = priceAgg.get(row.product_id)
      const nextCost  = row.unit_cost ?? prPrev?.unit_cost ?? 0
      const nextPrice = row.unit_price ?? prPrev?.unit_price ?? 0
      priceAgg.set(row.product_id, {
        product_id: row.product_id,
        unit_cost: nextCost,
        unit_price: nextPrice,
        effective_date: today()
      })
    }

    const invPayload = Array.from(invAgg.values())
    const pricePayload = Array.from(priceAgg.values())

    // ── UPSERT INVENTORY (one row per product) ───────────────────────────────────
    for (const part of chunk(invPayload, 500)) {
      const up = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' })
      if (up.error) return res.status(500).json({ error: up.error.message })
    }

    // ── UPSERT PRICES (avoid dup per day) ────────────────────────────────────────
    // If you have a unique index on (product_id, effective_date), this avoids the same error.
    for (const part of chunk(pricePayload, 500)) {
      const up = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (up.error) return res.status(500).json({ error: up.error.message })
    }

    return res.json({
      inventory_rows: invPayload.length,
      price_rows: pricePayload.length,
      rejected
    })
  } catch (e: any) {
    console.error('inventory upload error:', e)
    return res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

export default router
