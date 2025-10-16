// backend/routes/inventory.ts
import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
})

/** ───────────────────────── Helpers ───────────────────────── **/

// Safe string coercion (never call global String())
const toStr = (v: any): string => (v === null || v === undefined ? '' : String(v))

// Normalize for case-insensitive lookups
const norm = (v: any): string =>
  toStr(v)
    .replace(/^\uFEFF/, '') // strip BOM
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

// Remove leading "[...]" code, then trim.
const stripLeadingTag = (v: any): string =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

// Number parser tolerant to "1,234", "1 234", "1.234,56", etc.
function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let t = toStr(input).trim()
  if (!t) return null
  // If comma is decimal sep (e.g., "1.234,56")
  if (/,/.test(t) && !/\.\d+$/.test(t) && /,\d+$/.test(t)) {
    t = t.replace(/\./g, '')  // thousands
    t = t.replace(',', '.')   // decimal
  } else {
    t = t.replace(/[, ]/g, '') // remove separators
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function chunk<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Read first worksheet to AOA
function sheetToAOA(buf: Buffer) {
  const wb = xlsx.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error('No sheet found')
  const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
  if (!aoa?.length) throw new Error('No data in sheet')
  return aoa
}

/** Canonical header names (normalized) expected from your file */
const REQUIRED = [
  'name',
  'sales price',
  'cost',
  'quantity on hand'
] as const

/** Allow a few legacy/alternate header labels as aliases (all normalized) */
const HEADER_ALIASES: Record<(typeof REQUIRED)[number], string[]> = {
  'name': [],
  'sales price': ['sales price (current)'],
  'cost': [],
  'quantity on hand': ['quantity on hand (stocks)']
}

type CleanRow = {
  name: string
  unit_price: number
  unit_cost: number
  on_hand: number
}

/** ──────────────────────── Route ───────────────────────── **/

router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'File is required (field name "file")' })

    // Parse sheet → header map
    let aoa: any[][]
    try {
      aoa = sheetToAOA(req.file.buffer)
    } catch {
      return res.status(400).json({
        error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.'
      })
    }

    const headerRow = (aoa[0] ?? []).map(h => toStr(h))
    if (!headerRow.length)
      return res.status(400).json({ error: 'Header row missing' })

    // Build index map for required headers, accepting aliases
    const idxMap: Record<(typeof REQUIRED)[number], number> = {
      'name': -1,
      'sales price': -1,
      'cost': -1,
      'quantity on hand': -1
    }

    const normalizedHeaders = headerRow.map(h => norm(h))

    normalizedHeaders.forEach((nh, i) => {
      for (const key of REQUIRED) {
        if (idxMap[key] !== -1) continue
        if (nh === key || HEADER_ALIASES[key].includes(nh)) {
          idxMap[key] = i
        }
      }
    })

    const missing = REQUIRED.filter(k => idxMap[k] === -1)
    if (missing.length) {
      return res.status(400).json({
        error:
          'Invalid headers. Expected: Name, Sales Price, Cost, Quantity On Hand',
        details: { received: headerRow, missing }
      })
    }

    // Body rows (non-empty)
    const rows = aoa
      .slice(1)
      .filter(r => r && r.some((c: any) => c !== null && c !== undefined && toStr(c).trim() !== ''))

    if (!rows.length)
      return res.status(400).json({ error: 'No data rows found' })

    const clean: CleanRow[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    // Parse + validate
    rows.forEach((r, i) => {
      const rowNum = i + 2
      const name = toStr(r[idxMap['name']]).trim()
      const price = parseNumber(r[idxMap['sales price']])
      const cost  = parseNumber(r[idxMap['cost']])
      const onH   = parseNumber(r[idxMap['quantity on hand']])

      if (!name) return reject(rowNum, 'Missing Name')
      if (price === null) return reject(rowNum, 'Invalid Sales Price')
      if (cost === null)  return reject(rowNum, 'Invalid Cost')
      if (onH === null)   return reject(rowNum, 'Invalid On Hand')

      clean.push({ name, unit_price: price, unit_cost: cost, on_hand: onH })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // Build name → id maps from existing products
    const allProds = await supabaseService.from('products').select('id,name')
    if (allProds.error)
      return res.status(500).json({ error: allProds.error.message })

    const exactMap = new Map<string, string>()
    const strippedMap = new Map<string, string>()

    for (const p of allProds.data ?? []) {
      const id = toStr(p.id)
      const name = toStr(p.name)
      const exactKey = norm(name)
      const strippedKey = norm(stripLeadingTag(name))
      if (exactKey && !exactMap.has(exactKey)) exactMap.set(exactKey, id)
      if (strippedKey && !strippedMap.has(strippedKey)) strippedMap.set(strippedKey, id)
    }

    // Resolve each clean row → product_id using exact OR stripped matching
    type Resolved = CleanRow & { product_id?: string; matched_name?: string }
    const resolved: Resolved[] = []

    for (const r of clean) {
      const incoming = toStr(r.name)
      const exactKey = norm(incoming)
      const strippedKey = norm(stripLeadingTag(incoming))

      let product_id = exactMap.get(exactKey)
      let matched_name: string | undefined

      if (!product_id) {
        product_id = strippedMap.get(strippedKey)
      }

      if (product_id) {
        const found = (allProds.data ?? []).find(p => toStr(p.id) === product_id)
        matched_name = toStr(found?.name ?? incoming)
      }

      if (!product_id) {
        reject(-1, `No matching product for "${incoming}"`)
        continue
      }

      resolved.push({ ...r, product_id, matched_name })
    }

    if (!resolved.length) {
      return res.status(400).json({
        error: 'No rows matched existing products',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    const todayISO = new Date().toISOString().slice(0, 10)

    type PriceRow = {
      product_id: string
      effective_date: string
      unit_cost: number
      unit_price: number
      source?: string
    }
    type InvRow = {
      product_id: string
      as_of_date: string
      on_hand: number
      source?: string
    }

    const pricePayload: PriceRow[] = []
    const invPayload: InvRow[] = []

    for (const r of resolved) {
      const pid = toStr(r.product_id)
      pricePayload.push({
        product_id: pid,
        effective_date: todayISO,
        unit_cost: Number(r.unit_cost) || 0,
        unit_price: Number(r.unit_price) || 0,
        source: 'inventory'
      })
      invPayload.push({
        product_id: pid,
        as_of_date: todayISO,
        on_hand: Number(r.on_hand) || 0,
        source: 'inventory'
      })
    }

    // Insert in chunks; onConflict ensures one row per day per product
    let priceInserted = 0
    for (const part of chunk(pricePayload, 500)) {
      const ins = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (ins.error) {
        console.error('product_prices upsert error:', ins.error)
        return res.status(500).json({ error: ins.error.message })
      }
      priceInserted += (ins.count as number) ?? part.length
    }

    let invInserted = 0
    for (const part of chunk(invPayload, 500)) {
      const ins2 = await supabaseService
        .from('inventory_levels')
        .upsert(part, { onConflict: 'product_id,as_of_date' })
      if (ins2.error) {
        console.error('inventory_levels upsert error:', ins2.error)
        return res.status(500).json({ error: ins2.error.message })
      }
      invInserted += (ins2.count as number) ?? part.length
    }

    return res.json({
      matched_products: resolved.length,
      price_rows: priceInserted,
      inventory_rows: invInserted,
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50)
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/inventory/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Inventory upload failed' })
  }
})

export default router
