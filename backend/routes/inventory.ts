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

const norm = (v: any) =>
  toStr(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ')

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

// canonical headers and accepted aliases
const REQUIRED = ['name', 'sales price', 'cost', 'quantity on hand'] as const
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

/* --------------------------- route --------------------------- */

router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required (field name "file")' })
    }

    // parse file
    let aoa: any[][]
    try {
      aoa = sheetToAOA(req.file.buffer)
    } catch {
      return res.status(400).json({ error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.' })
    }

    // map headers
    const headerRow = (aoa[0] ?? []).map(h => toStr(h))
    const idxMap: Record<(typeof REQUIRED)[number], number> = {
      'name': -1,
      'sales price': -1,
      'cost': -1,
      'quantity on hand': -1
    }
    headerRow
      .map(h => norm(h))
      .forEach((nh, i) => {
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
        error: 'Invalid headers. Expected: Name, Sales Price, Cost, Quantity On Hand',
        details: { received: headerRow, missing }
      })
    }

    // rows
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
      const name = toStr(r[idxMap['name']]).trim()
      const price = parseNumber(r[idxMap['sales price']])
      const cost = parseNumber(r[idxMap['cost']])
      const onH = parseNumber(r[idxMap['quantity on hand']])

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
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // product map
    const allProds = await supabaseService.from('products').select('id,name')
    if (allProds.error) return res.status(500).json({ error: allProds.error.message })

    const exactMap = new Map<string, string>()
    const strippedMap = new Map<string, string>()
    for (const p of allProds.data ?? []) {
      const id = toStr(p.id)
      const name = toStr(p.name)
      const ek = norm(name)
      const sk = norm(stripLeadingTag(name))
      if (ek && !exactMap.has(ek)) exactMap.set(ek, id)
      if (sk && !strippedMap.has(sk)) strippedMap.set(sk, id)
    }

    type Resolved = CleanRow & { product_id?: string; matched_name?: string }
    const resolved: Resolved[] = []
    for (const r of clean) {
      const incoming = toStr(r.name)
      const pid =
        exactMap.get(norm(incoming)) ??
        strippedMap.get(norm(stripLeadingTag(incoming)))
      if (!pid) {
        reject(-1, `No matching product for "${incoming}"`)
        continue
      }
      const found = (allProds.data ?? []).find(p => toStr(p.id) === pid)
      resolved.push({
        ...r,
        product_id: pid,
        matched_name: toStr(found?.name ?? incoming)
      })
    }

    if (!resolved.length) {
      return res.status(400).json({
        error: 'No rows matched existing products',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // build payloads
    type PriceRow = {
      product_id: string
      effective_date: string
      unit_cost: number
      unit_price: number
    }
    type InvRow = {
      product_id: string
      on_hand: number
      backorder?: number
    }

    const todayISO = new Date().toISOString().slice(0, 10)
    const pricePayload: PriceRow[] = []
    const invPayload: InvRow[] = []

    for (const r of resolved) {
      const pid = toStr(r.product_id)
      pricePayload.push({
        product_id: pid,
        effective_date: todayISO,
        unit_cost: Number(r.unit_cost) || 0,
        unit_price: Number(r.unit_price) || 0
      })
      // inventory_current has no as_of_date – only product_id (PK), on_hand, backorder
      invPayload.push({
        product_id: pid,
        on_hand: Number(r.on_hand) || 0,
        backorder: 0
      })
    }

    // Dedupe by unique keys:
    // product_prices => (product_id, effective_date)
    const uniqPrice = Array.from(
      pricePayload
        .reduce(
          (m, row) => m.set(`${row.product_id}|${row.effective_date}`, row),
          new Map<string, PriceRow>()
        )
        .values()
    )
    // inventory_current => product_id
    const uniqInv = Array.from(
      invPayload
        .reduce(
          (m, row) => m.set(row.product_id, row), // last one wins
          new Map<string, InvRow>()
        )
        .values()
    )

    // upsert prices
    let priceInserted = 0
    for (const part of chunk(uniqPrice, 500)) {
      const ins = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (ins.error) {
        console.error('product_prices upsert error:', ins.error)
        return res.status(500).json({ error: ins.error.message })
      }
      priceInserted += part.length
    }

    // upsert inventory_current (conflict on single-column PK)
    let invInserted = 0
    for (const part of chunk(uniqInv, 500)) {
      const ins2 = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' })
      if (ins2.error) {
        console.error('inventory_current upsert error:', ins2.error)
        return res.status(500).json({ error: ins2.error.message })
      }
      invInserted += part.length
    }

    return res.json({
      matched_products: resolved.length,
      price_rows: priceInserted,
      inventory_rows: invInserted,
      collapsed_duplicates: {
        product_prices: pricePayload.length - uniqPrice.length,
        inventory_current: invPayload.length - uniqInv.length
      },
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50)
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/inventory/upload error:', e)
    return res
      .status(500)
      .json({ error: e?.message || 'Inventory upload failed' })
  }
})

export default router
