import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase.js'

const router = Router()

// Keep your existing 30MB limit (raise if your sheets are bigger)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
})

/* -------------------------- helpers -------------------------- */

const toStr = (v: any) => (v === null || v === undefined ? '' : String(v))

// normalized_name we store in DB
const normalize = (v: any) =>
  toStr(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ')

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

// Canonical headers and accepted aliases (as you had)
const REQUIRED = ['name', 'sales price', 'cost', 'quantity on hand'] as const
const ALIASES: Record<(typeof REQUIRED)[number], string[]> = {
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
      return res.status(400).json({ error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.' })
    }

    // Map headers
    const headerRow = (aoa[0] ?? []).map(h => toStr(h))
    const idx: Record<(typeof REQUIRED)[number], number> = {
      'name': -1, 'sales price': -1, 'cost': -1, 'quantity on hand': -1
    }
    headerRow.map(h => normalize(h)).forEach((nh, i) => {
      for (const key of REQUIRED) {
        if (idx[key] !== -1) continue
        if (nh === key || ALIASES[key].includes(nh)) idx[key] = i
      }
    })
    const missing = REQUIRED.filter(k => idx[k] === -1)
    if (missing.length) {
      return res.status(400).json({
        error: 'Invalid headers. Expected: Name, Sales Price, Cost, Quantity On Hand',
        details: { received: headerRow, missing }
      })
    }

    // Rows -> clean
    const rows = aoa.slice(1).filter(r => r && r.some((c: any) => toStr(c).trim() !== ''))
    if (!rows.length) return res.status(400).json({ error: 'No data rows found' })

    const clean: CleanRow[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    rows.forEach((r, i) => {
      const rowNum = i + 2
      const name  = toStr(r[idx['name']]).trim()
      const price = parseNumber(r[idx['sales price']])
      const cost  = parseNumber(r[idx['cost']])
      const onH   = parseNumber(r[idx['quantity on hand']])

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

    /* ----------------------------------------------------------------
       1) Ensure products exist (CREATE if missing) using the exact name
          you give us (includes the [####] ref), PLUS populate normalized_name.
       ---------------------------------------------------------------- */
    const uniqueNames = Array.from(new Set(clean.map(r => r.name)))
    const productUpserts = uniqueNames.map(name => ({
      name,
      normalized_name: normalize(name)
    }))

    // Upsert by name (unique constraint on products.name)
    const up = await supabaseService
      .from('products')
      .upsert(productUpserts, { onConflict: 'name' })
    if (up.error) {
      return res.status(500).json({ error: up.error.message })
    }

    // Fetch back ids by exact names (should all exist now)
    const idMap = new Map<string, string>()
    for (const part of chunk(uniqueNames, 500)) {
      const r = await supabaseService
        .from('products')
        .select('id,name')
        .in('name', part)
      if (r.error) return res.status(500).json({ error: r.error.message })
      for (const p of r.data ?? []) idMap.set(toStr(p.name), toStr(p.id))
    }

    // Any still missing → report (should be zero unless name too long/null)
    const missingNames = uniqueNames.filter(n => !idMap.has(n))
    if (missingNames.length) {
      return res.status(500).json({
        error: 'Failed to resolve product ids for some names',
        details: missingNames.slice(0, 20)
      })
    }

    /* ----------------------------------------------------------------
       2) Build payloads for price + inventory and upsert
       ---------------------------------------------------------------- */
    type PriceRow = { product_id: string; effective_date: string; unit_cost: number; unit_price: number }
    type InvRow   = { product_id: string; on_hand: number; backorder?: number }

    const todayISO = new Date().toISOString().slice(0, 10)
    const pricePayload: PriceRow[] = []
    const invPayload:   InvRow[]   = []

    for (const r of clean) {
      const pid = idMap.get(r.name)!
      pricePayload.push({
        product_id: pid,
        effective_date: todayISO,
        unit_cost: Number(r.unit_cost) || 0,
        unit_price: Number(r.unit_price) || 0
      })
      invPayload.push({
        product_id: pid,
        on_hand: Number(r.on_hand) || 0,
        backorder: 0
      })
    }

    // Collapse duplicates within the same upload (keep last)
    const uniqPrice = Array.from(
      pricePayload.reduce((m, row) => m.set(`${row.product_id}|${row.effective_date}`, row), new Map<string, PriceRow>()).values()
    )
    const uniqInv = Array.from(
      invPayload.reduce((m, row) => m.set(row.product_id, row), new Map<string, InvRow>()).values()
    )

    // Upsert prices
    let priceRows = 0
    for (const part of chunk(uniqPrice, 500)) {
      const ins = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (ins.error) return res.status(500).json({ error: ins.error.message })
      priceRows += part.length
    }

    // Upsert inventory
    let invRows = 0
    for (const part of chunk(uniqInv, 500)) {
      const ins2 = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' })
      if (ins2.error) return res.status(500).json({ error: ins2.error.message })
      invRows += part.length
    }

    return res.json({
      products_seen: uniqueNames.length,
      products_upserted_or_matched: uniqueNames.length,
      price_rows: priceRows,
      inventory_rows: invRows,
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
