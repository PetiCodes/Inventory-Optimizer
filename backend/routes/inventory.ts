// backend/routes/inventory.ts
import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
})

// ---------- helpers ----------
const stripCode = (s: string) => s.replace(/^\s*\[[^\]]+\]\s*/g, '').trim()
const normalizeForMatch = (s: string) =>
  stripCode(s)
    .toLowerCase()
    .replace(/[™®]/g, '')
    .replace(/[.,/\\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let s = String(input).trim()
  if (s === '') return null
  // If comma is decimal sep (e.g., 1.234,56)
  if (/,/.test(s) && /,\d+$/.test(s) && !/\.\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    s = s.replace(/[, ]/g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Dice coefficient on bigrams (0..1), fast & dependency-free */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = (t: string) => {
    const arr: string[] = []
    for (let i = 0; i < t.length - 1; i++) arr.push(t.slice(i, i + 2))
    return arr
  }
  const aB = bigrams(a)
  const bB = bigrams(b)
  const map = new Map<string, number>()
  for (const g of aB) map.set(g, (map.get(g) || 0) + 1)
  let matches = 0
  for (const g of bB) {
    const c = map.get(g) || 0
    if (c > 0) {
      matches++
      map.set(g, c - 1)
    }
  }
  return (2 * matches) / (aB.length + bB.length)
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
 * Matching strategy (no new products are created):
 *  1) exact name
 *  2) exact catalog stripped [code] vs uploaded raw
 *  3) uploaded stripped vs catalog stripped
 *  4) normalized (case/space/punct insensitive)
 *  5) fuzzy fallback on normalized names (Dice similarity >= 0.90) when a single best candidate exists
 */
router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File is required (field "file")' })

    // read sheet
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) return res.status(400).json({ error: 'No sheet found in file' })

    // AOA
    const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
    if (!aoa?.length) return res.status(400).json({ error: 'Empty sheet' })

    const headers = (aoa[0] ?? []).map(h => String(h ?? '').trim())
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
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string, name?: string) => {
      rejected.push({ row, reason, name })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    for (let i = 0; i < body.length; i++) {
      const r = body[i]
      const rowNum = i + 2

      const name  = String(r[idx.name] ?? '').trim()
      const onH   = parseNumber(r[idx.onhand])
      const cost  = idx.cost  !== -1 ? parseNumber(r[idx.cost])  : null
      const price = idx.price !== -1 ? parseNumber(r[idx.price]) : null

      if (!name)              { reject(rowNum, 'Missing Name'); continue }
      if (onH === null)       { reject(rowNum, 'Invalid Quantity On Hand', name); continue }

      let on_hand = onH
      let backorder = 0
      if (on_hand < 0) { backorder = Math.abs(on_hand); on_hand = 0 }

      clean.push({ input_name: name, on_hand, backorder, unit_cost: cost, unit_price: price })
    }

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // ---- fetch all products to build match maps ----
    const prodSel = await supabaseService.from('products').select('id,name,normalized_name').limit(100000)
    if (prodSel.error) return res.status(500).json({ error: prodSel.error.message })
    const all = prodSel.data ?? []

    const idByExact = new Map(all.map(p => [p.name, p.id]))
    const idByStripped = new Map<string, string>()   // stripCode(catalog name)
    const idByNormalized = new Map<string, string>() // normalized_name or computed normalization
    const normalizedKeys: string[] = []

    for (const p of all) {
      const stripped = stripCode(p.name)
      const normalized = p.normalized_name ? p.normalized_name : normalizeForMatch(p.name)
      if (!idByStripped.has(stripped)) idByStripped.set(stripped, p.id)
      if (!idByNormalized.has(normalized)) {
        idByNormalized.set(normalized, p.id)
        normalizedKeys.push(normalized)
      }
    }

    // ---- match rows to product_id ----
    type Matched = CleanRow & { product_id: string }
    const matched: Matched[] = []

    for (let i = 0; i < clean.length; i++) {
      const row = clean[i]

      // 1) exact
      let product_id = idByExact.get(row.input_name)

      // 2) catalog stripped equals uploaded raw
      if (!product_id) product_id = idByStripped.get(row.input_name)

      // 3) uploaded stripped equals catalog stripped
      if (!product_id) product_id = idByStripped.get(stripCode(row.input_name))

      // 4) normalized match
      if (!product_id) product_id = idByNormalized.get(normalizeForMatch(row.input_name))

      // 5) fuzzy fallback on normalized
      if (!product_id) {
        const target = normalizeForMatch(row.input_name)
        let best = 0
        let bestKey = ''
        for (const k of normalizedKeys) {
          const sim = diceSimilarity(target, k)
          if (sim > best) { best = sim; bestKey = k }
        }
        if (best >= 0.90) { // threshold; tune if needed
          product_id = idByNormalized.get(bestKey) || null
        }
      }

      if (!product_id) {
        reject(i + 2, 'No matching product name', row.input_name)
        continue
      }
      matched.push({ ...row, product_id })
    }

    if (!matched.length) {
      return res.status(400).json({
        error: 'No rows matched existing products',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // ---- aggregate per product to avoid double-upsert conflicts ----
    const invAgg = new Map<string, { product_id: string; on_hand: number; backorder: number; updated_at: string }>()
    const priceAgg = new Map<string, { product_id: string; unit_cost: number; unit_price: number; effective_date: string }>()

    for (const row of matched) {
      // inventory sum
      const prev = invAgg.get(row.product_id)
      if (!prev) {
        invAgg.set(row.product_id, {
          product_id: row.product_id,
          on_hand: row.on_hand,
          backorder: row.backorder,
          updated_at: nowISO()
        })
      } else {
        prev.on_hand += row.on_hand
        prev.backorder += row.backorder
      }

      // price last-non-null wins
      const prevP = priceAgg.get(row.product_id)
      const nextCost  = row.unit_cost ?? prevP?.unit_cost ?? 0
      const nextPrice = row.unit_price ?? prevP?.unit_price ?? 0
      priceAgg.set(row.product_id, {
        product_id: row.product_id,
        unit_cost: nextCost,
        unit_price: nextPrice,
        effective_date: today()
      })
    }

    const invPayload = Array.from(invAgg.values())
    const pricePayload = Array.from(priceAgg.values())

    // ---- UPSERT inventory_current (on product_id) ----
    for (const part of chunk(invPayload, 500)) {
      const up = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' })
      if (up.error) return res.status(500).json({ error: up.error.message })
    }

    // ---- UPSERT product_prices (on product_id, effective_date) ----
    for (const part of chunk(pricePayload, 500)) {
      const up = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (up.error) return res.status(500).json({ error: up.error.message })
    }

    return res.json({
      inventory_rows: invPayload.length,
      price_rows: pricePayload.length,
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50)
    })
  } catch (e: any) {
    console.error('inventory upload error:', e)
    return res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

export default router
