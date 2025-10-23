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

const stripBOM = (s: string) => s.replace(/^\uFEFF/, '')
const collapseSpaces = (s: string) => s.replace(/\s+/g, ' ')

/** Normalize any leading brackets to simple [..], keep if present, then trim */
function canonName(raw: any): string {
  const t = stripBOM(toStr(raw)).trim()
  // normalize odd bracket glyphs to ASCII [ ]
  const normBrackets = t.replace(/^\s*[［\[]([^］\]]+)[］\]]\s*/, '[$1] ')
  return collapseSpaces(normBrackets)
}

/** Legacy safety (does not run on DB values—only as a fallback key) */
const stripLeadingTag = (v: any) =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let t = toStr(input).trim()
  if (!t) return null
  if (/,/.test(t) && !/\.\d+$/.test(t) && /,\d+$/.test(t)) {
    t = t.replace(/\./g, '').replace(',', '.')
  } else {
    t = t.replace(/[, ]/g, '')
  }
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function chunk<T>(arr: T[], size = 75): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

function sheetToAOA(buf: Buffer) {
  const wb = xlsx.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error('No sheet found')
  const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
  if (!aoa?.length) throw new Error('No data in sheet')
  return aoa
}

// Required headers + aliases
const REQUIRED = ['name', 'sales price', 'cost', 'quantity on hand'] as const
const ALIASES: Record<(typeof REQUIRED)[number], string[]> = {
  'name': [],
  'sales price': ['sales price (current)'],
  'cost': [],
  'quantity on hand': ['quantity on hand (stocks)']
}

type CleanRow = { name: string; unit_price: number; unit_cost: number; on_hand: number }

/* --------------------------- route --------------------------- */

router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  const stage = { parse: false, upsertProducts: 0, builtAgg: 0, mapProducts: 0, priceBatches: 0, invBatches: 0 }
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required (field name "file")' })
    }

    // Parse file
    let aoa: any[][]
    try {
      aoa = sheetToAOA(req.file.buffer)
      stage.parse = true
    } catch {
      return res.status(400).json({ error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.' })
    }

    // Map headers
    const headerRow = (aoa[0] ?? []).map(h => toStr(h))
    const idx: Record<(typeof REQUIRED)[number], number> = {
      'name': -1, 'sales price': -1, 'cost': -1, 'quantity on hand': -1
    }
    headerRow.map(h => toStr(h).trim().toLowerCase().replace(/\s+/g, ' ')).forEach((nh, i) => {
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

    // Body rows (skip fully empty)
    const body = aoa.slice(1).filter(r => r && r.some((c: any) => toStr(c).trim() !== ''))
    if (!body.length) return res.status(400).json({ error: 'No data rows found' })

    // Clean rows
    const rawClean: CleanRow[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    body.forEach((r, i) => {
      const rowNum = i + 2
      const name  = canonName(r[idx['name']])
      const price = parseNumber(r[idx['sales price']])
      const cost  = parseNumber(r[idx['cost']])
      const onH   = parseNumber(r[idx['quantity on hand']])

      if (!name) return reject(rowNum, 'Missing Name')
      if (price === null) return reject(rowNum, 'Invalid Sales Price')
      if (cost === null)  return reject(rowNum, 'Invalid Cost')
      if (onH === null)   return reject(rowNum, 'Invalid On Hand')

      rawClean.push({ name, unit_price: price, unit_cost: cost, on_hand: onH })
    })

    if (!rawClean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // ---- FIX #1: Aggregate duplicates by Name (sum on_hand; keep last non-null price/cost) ----
    type AggRow = { name: string; unit_price: number; unit_cost: number; on_hand: number }
    const agg = new Map<string, AggRow>()
    for (const r of rawClean) {
      const key = r.name
      const prev = agg.get(key)
      if (!prev) {
        agg.set(key, { ...r })
      } else {
        // Sum quantities, keep the latest price/cost (file order is kept)
        agg.set(key, {
          name: key,
          on_hand: (Number(prev.on_hand) || 0) + (Number(r.on_hand) || 0),
          unit_price: Number.isFinite(r.unit_price) ? r.unit_price : prev.unit_price,
          unit_cost:  Number.isFinite(r.unit_cost)  ? r.unit_cost  : prev.unit_cost
        })
      }
    }
    const clean = Array.from(agg.values())
    stage.builtAgg = clean.length

    // 1) Ensure products exist (create new if missing) — use aggregated names
    const uniqueNames = clean.map(r => r.name)
    for (const part of chunk(uniqueNames, 75)) {
      const up = await supabaseService
        .from('products')
        .upsert(part.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
      if (up.error) return res.status(500).json({ error: up.error.message, stage, step: 'upsert_products' })
      stage.upsertProducts += part.length
      await sleep(5)
    }

    // 2) Robust mapping: fetch ALL products once, build multiple keys → id
    const allP = await supabaseService.from('products').select('id,name')
    if (allP.error) return res.status(500).json({ error: allP.error.message, stage, step: 'fetch_all_products' })

    const exactMap = new Map<string, string>()
    const strippedMap = new Map<string, string>()
    for (const p of allP.data ?? []) {
      const id = String((p as any).id)
      const nm = String((p as any).name)
      const cExact = canonName(nm)
      const cStrip = canonName(stripLeadingTag(nm))
      if (cExact && !exactMap.has(cExact)) exactMap.set(cExact, id)
      if (cStrip && !strippedMap.has(cStrip)) strippedMap.set(cStrip, id)
    }
    stage.mapProducts = exactMap.size

    // 3) Build payloads with *aggregated* on_hand
    type PriceRow = { product_id: string; effective_date: string; unit_cost: number; unit_price: number }
    type InvRow   = { product_id: string; on_hand: number; backorder?: number }

    const todayISO = new Date().toISOString().slice(0, 10)
    const pricePayload: PriceRow[] = []
    const invPayload:   InvRow[]   = []

    const unmatched: string[] = []

    for (const r of clean) {
      const byExact = exactMap.get(r.name)
      const byStrip = exactMap.get(canonName(stripLeadingTag(r.name))) || strippedMap.get(canonName(stripLeadingTag(r.name)))
      const pid = byExact ?? byStrip
      if (!pid) {
        unmatched.push(r.name)
        continue
      }

      const unit_cost  = Number.isFinite(Number(r.unit_cost))  ? Number(r.unit_cost)  : 0
      const unit_price = Number.isFinite(Number(r.unit_price)) ? Number(r.unit_price) : 0
      const on_hand    = Number.isFinite(Number(r.on_hand))    ? Number(r.on_hand)    : 0

      pricePayload.push({
        product_id: pid,
        effective_date: todayISO,
        unit_cost,
        unit_price
      })
      invPayload.push({
        product_id: pid,
        on_hand,
        backorder: 0
      })
    }

    // Collapse duplicates by (product_id|effective_date) and product_id
    const uniqPrice = Array.from(
      pricePayload.reduce((m, row) => m.set(`${row.product_id}|${row.effective_date}`, row), new Map<string, PriceRow>()).values()
    )
    const uniqInv = Array.from(
      invPayload.reduce((m, row) => {
        const existing = m.get(row.product_id)
        if (!existing) {
          m.set(row.product_id, row)
        } else {
          // If somehow duplicates slipped in after mapping, **sum** on_hand as well
          m.set(row.product_id, { ...row, on_hand: (existing.on_hand || 0) + (row.on_hand || 0) })
        }
        return m
      }, new Map<string, InvRow>()).values()
    )

    // 4) Upserts (small batches + sleep)
    let priceInserted = 0
    for (const part of chunk(uniqPrice, 75)) {
      const ins = await supabaseService
        .from('product_prices')
        .upsert(part, { onConflict: 'product_id,effective_date' })
      if (ins.error) {
        return res.status(500).json({
          error: ins.error.message,
          failingSample: part.slice(0, 5),
          stage,
          step: 'upsert_prices'
        })
      }
      priceInserted += part.length
      stage.priceBatches++
      await sleep(6)
    }

    let invInserted = 0
    for (const part of chunk(uniqInv, 75)) {
      const ins2 = await supabaseService
        .from('inventory_current')
        .upsert(part, { onConflict: 'product_id' })
      if (ins2.error) {
        return res.status(500).json({
          error: ins2.error.message,
          failingSample: part.slice(0, 5),
          stage,
          step: 'upsert_inventory'
        })
      }
      invInserted += part.length
      stage.invBatches++
      await sleep(6)
    }

    // 5) VERIFY & RETRY missing inventory rows for *this* upload
    const uploadedPids = Array.from(new Set(uniqInv.map(r => r.product_id)))
    const existingInv = new Set<string>()
    for (const part of chunk(uploadedPids, 200)) {
      const q = await supabaseService.from('inventory_current').select('product_id').in('product_id', part)
      if (q.error) break
      for (const r of q.data ?? []) existingInv.add(String((r as any).product_id))
      await sleep(3)
    }
    const missingPids = uploadedPids.filter(pid => !existingInv.has(pid))
    const retried: string[] = []
    const retryFailed: { product_id: string; reason: string }[] = []

    for (const pid of missingPids) {
      const row = uniqInv.find(r => r.product_id === pid)
      if (!row) continue
      const attempt = await supabaseService.from('inventory_current').upsert(row, { onConflict: 'product_id' })
      if (attempt.error) retryFailed.push({ product_id: pid, reason: attempt.error.message })
      else retried.push(pid)
      await sleep(2)
    }

    return res.json({
      summary: {
        products_in_file: rawClean.length,
        products_after_aggregation: clean.length,
        unmatched_names: unmatched.length
      },
      matched_products: clean.length - unmatched.length,
      price_rows: priceInserted,
      inventory_rows: invInserted,
      verify: {
        uploaded_products: uploadedPids.length,
        found_inventory_rows: existingInv.size,
        missing_before_retry: missingPids.length,
        retried_success: retried.length,
        retry_failed: retryFailed
      },
      collapsed_duplicates: {
        product_prices: pricePayload.length - uniqPrice.length,
        inventory_current: invPayload.length - uniqInv.length
      },
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50),
      stage
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/inventory/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Inventory upload failed' })
  }
})

export default router
