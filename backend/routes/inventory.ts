import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
})

/* -------------------------- helpers -------------------------- */

const toStr = (v: any) => (v === null || v === undefined ? '' : String(v))

/** normalize: trim, lowercase, collapse spaces */
const norm = (v: any) =>
  toStr(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ')

/** remove a single leading "[...]" tag if present */
const stripLeadingTag = (v: any) =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let t = toStr(input).trim()
  if (!t) return null
  // 1.234,56 style
  if (/,/.test(t) && !/\.\d+$/.test(t) && /,\d+$/.test(t)) {
    t = t.replace(/\./g, '').replace(',', '.')
  } else {
    t = t.replace(/[, ]/g, '')
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function chunk<T>(arr: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function sheetToAOA(buf: Buffer) {
  const wb = xlsx.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error('No sheet found')
  const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
  if (!aoa?.length) throw new Error('No data in sheet')
  return aoa
}

// Canonical headers and accepted aliases
const REQUIRED = ['name', 'sales price', 'cost', 'quantity on hand'] as const
const ALIASES: Record<(typeof REQUIRED)[number], string[]> = {
  name: [],
  'sales price': ['sales price (current)'],
  cost: [],
  'quantity on hand': ['quantity on hand (stocks)'],
}

type CleanRow = {
  name: string
  unit_price: number
  unit_cost: number
  on_hand: number
}

/* --------------------------- route --------------------------- */

router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required (field name "file")' })
    }

    // Parse file
    let aoa: any[][]
    try {
      aoa = sheetToAOA(req.file.buffer)
    } catch {
      return res.status(400).json({
        error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.',
      })
    }

    // Map headers
    const headerRow = (aoa[0] ?? []).map((h) => toStr(h))
    const idx: Record<(typeof REQUIRED)[number], number> = {
      name: -1,
      'sales price': -1,
      cost: -1,
      'quantity on hand': -1,
    }
    headerRow
      .map((h) => norm(h))
      .forEach((nh, i) => {
        for (const key of REQUIRED) {
          if (idx[key] !== -1) continue
          if (nh === key || ALIASES[key].includes(nh)) idx[key] = i
        }
      })
    const missing = REQUIRED.filter((k) => idx[k] === -1)
    if (missing.length) {
      return res.status(400).json({
        error:
          'Invalid headers. Expected: Name, Sales Price, Cost, Quantity On Hand',
        details: { received: headerRow, missing },
      })
    }

    // Rows -> clean
    const rows = aoa
      .slice(1)
      .filter((r) => r && r.some((c: any) => toStr(c).trim() !== ''))
    if (!rows.length)
      return res.status(400).json({ error: 'No data rows found' })

    const clean: CleanRow[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const bump = (reason: string) =>
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      bump(reason)
    }

    rows.forEach((r, i) => {
      const rowNum = i + 2
      const name = toStr(r[idx['name']]).trim()
      const price = parseNumber(r[idx['sales price']])
      const cost = parseNumber(r[idx['cost']])
      const onH = parseNumber(r[idx['quantity on hand']])

      if (!name) return reject(rowNum, 'Missing Name')
      if (price === null) return reject(rowNum, 'Invalid Sales Price')
      if (cost === null) return reject(rowNum, 'Invalid Cost')
      if (onH === null) return reject(rowNum, 'Invalid On Hand')

      clean.push({ name, unit_price: price, unit_cost: cost, on_hand: onH })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50),
      })
    }

    /* ---------------------------------------------------------------
     * 1) Ensure products exist (upsert by name) and set normalized_name
     *    normalized_name := norm(stripLeadingTag(name))
     * --------------------------------------------------------------- */
    const uniqNames = Array.from(new Set(clean.map((r) => r.name)))
    const upsertProducts = uniqNames.map((name) => ({
      name,
      normalized_name: norm(stripLeadingTag(name)),
    }))

    // Upsert by 'name' (unique)
    const upProducts = await supabaseService
      .from('products')
      .upsert(upsertProducts, { onConflict: 'name', ignoreDuplicates: true })
    if (upProducts.error)
      return res.status(500).json({ error: upProducts.error.message })

    // Fetch ids for the names we just upserted.
    // We match by exact name OR by normalized_name (derived from the file),
    // so a future file that drops the [####] still finds the same product.
    const uniqNorms = Array.from(
      new Set(uniqNames.map((n) => norm(stripLeadingTag(n))))
    )

    const inPartsNames = chunk(uniqNames, 500)
    const inPartsNorms = chunk(uniqNorms, 500)

    const found: Array<{ id: string; name: string; normalized_name: string | null }> = []

    for (const part of inPartsNames) {
      const r = await supabaseService
        .from('products')
        .select('id,name,normalized_name')
        .in('name', part)
      if (r.error) return res.status(500).json({ error: r.error.message })
      found.push(...(r.data ?? []))
    }
    // Add any that matched only via normalized_name
    for (const part of inPartsNorms) {
      const r = await supabaseService
        .from('products')
        .select('id,name,normalized_name')
        .in('normalized_name', part)
      if (r.error) return res.status(500).json({ error: r.error.message })
      // Avoid duplicates by id
      const have = new Set(found.map((x) => x.id))
      for (const row of r.data ?? []) if (!have.has(row.id)) found.push(row)
    }

    const byExact = new Map(found.map((p) => [p.name, p.id]))
    const byNorm = new Map(
      found.map((p) => [norm(p.normalized_name ?? ''), p.id])
    )

    /* ---------------------------------------------------------------
     * 2) Build price + inventory payloads mapped to product_id
     * --------------------------------------------------------------- */
    const todayISO = new Date().toISOString().slice(0, 10)

    type PriceRow = {
      product_id: string
      effective_date: string
      unit_cost: number
      unit_price: number
    }
    type InvRow = { product_id: string; on_hand: number; backorder?: number }

    const pricePayload: PriceRow[] = []
    const invPayload: InvRow[] = []

    let matchedExact = 0
    let matchedNormalized = 0
    let unmatched = 0

    for (const r of clean) {
      const pidExact = byExact.get(r.name)
      const pidNorm = byNorm.get(norm(stripLeadingTag(r.name)))
      const pid = pidExact ?? pidNorm
      if (!pid) {
        unmatched++
        continue
      }
      if (pidExact) matchedExact++
      else matchedNormalized++

      pricePayload.push({
        product_id: pid,
        effective_date: todayISO,
        unit_cost: Number(r.unit_cost) || 0,
        unit_price: Number(r.unit_price) || 0,
      })
      invPayload.push({
        product_id: pid,
        on_hand: Number(r.on_hand) || 0,
        backorder: 0,
      })
    }

    if (!pricePayload.length || !invPayload.length) {
      return res.status(400).json({
        error: 'No rows matched existing products',
        details: {
          attempted: clean.length,
          unmatched,
          matchedExact,
          matchedNormalized,
        },
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50),
      })
    }

    // Collapse duplicates (keep the last occurrence in file)
    const uniqPrice = Array.from(
      pricePayload
        .reduce(
          (m, row) =>
            m.set(`${row.product_id}|${row.effective_date}`, row),
          new Map<string, PriceRow>()
        )
        .values()
    )
    const uniqInv = Array.from(
      invPayload
        .reduce(
          (m, row) => m.set(row.product_id, row),
          new Map<string, InvRow>()
        )
        .values()
    )

    /* ---------------------------------------------------------------
     * 3) Upserts (batched)
     * --------------------------------------------------------------- */
    let priceInserted = 0
    for (const part of chunk(uniqPrice, 500)) {
      const ins = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (ins.error) return res.status(500).json({ error: ins.error.message })
      priceInserted += part.length
    }

    let invInserted = 0
    for (const part of chunk(uniqInv, 500)) {
      const ins2 = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' }) // PK/unique
      if (ins2.error) return res.status(500).json({ error: ins2.error.message })
      invInserted += part.length
    }

    return res.json({
      matched_products: pricePayload.length, // same as invPayload length
      match_breakdown: { exact: matchedExact, normalized: matchedNormalized, unmatched },
      price_rows: priceInserted,
      inventory_rows: invInserted,
      collapsed_duplicates: {
        product_prices: pricePayload.length - uniqPrice.length,
        inventory_current: invPayload.length - uniqInv.length,
      },
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50),
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/inventory/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Inventory upload failed' })
  }
})

export default router
