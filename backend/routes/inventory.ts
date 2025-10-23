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

// Remove leading "[...]" tag in names
const stripLeadingTag = (v: any) =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

// Extract the content inside the very first leading [ ... ] if present
const extractRef = (v: any): string | null => {
  const m = toStr(v).match(/^\s*\[([^\]]+)\]/)
  return m ? m[1].trim() : null
}

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

// Use smaller default chunk size to avoid gateway resets
function chunk<T>(arr: T[], size = 120): T[][] {
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

/* --------------------- retry + diagnostics -------------------- */

// Basic sleep
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Wrap Supabase calls to survive transient network errors
async function callWithRetry<T>(
  fn: () => Promise<{ data: T; error: any }>,
  label: string,
  attemptMax = 3
): Promise<{ data: T; error: any; attempts: number }> {
  let lastErr: any = null
  for (let attempt = 1; attempt <= attemptMax; attempt++) {
    try {
      const res = await fn()
      if (res.error) {
        lastErr = res.error
      } else {
        return { ...res, attempts: attempt }
      }
    } catch (e: any) {
      // This is where "TypeError: fetch failed" shows up
      lastErr = e
    }
    const backoff = Math.min(1500 * attempt, 3000) + Math.floor(Math.random() * 250)
    console.warn(`[inventory.upload] ${label} attempt ${attempt} failed:`, lastErr?.message || lastErr)
    if (attempt < attemptMax) await sleep(backoff)
  }
  return { data: [] as any, error: lastErr, attempts: attemptMax }
}

// Quick connectivity probe (fast metadata call)
async function supabasePing(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { error } = await supabaseService.from('products').select('id', { head: true, count: 'exact' })
    if (error) return { ok: false, detail: error.message }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) }
  }
}

/* --------------------------- route --------------------------- */

router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File is required (field name "file")' })
    }

    // Connectivity probe up front (helps distinguish auth/network vs parsing issues)
    const ping = await supabasePing()
    if (!ping.ok) {
      return res.status(502).json({ error: 'Cannot reach database (preflight)', detail: ping.detail })
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
    headerRow.map(h => norm(h)).forEach((nh, i) => {
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
    const bump = (reason: string) => reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    const reject = (row: number, reason: string) => { rejected.push({ row, reason }); bump(reason) }

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

    // Fetch all products once (with retry)
    const prodSel = await callWithRetry(
      () => supabaseService.from('products').select('id,name'),
      'select products'
    )
    if (prodSel.error) {
      return res.status(502).json({ error: 'Failed to read products', detail: prodSel.error?.message || String(prodSel.error) })
    }
    const prods = (prodSel.data as any[]) ?? []

    // Build indexes: exact name, reference code, stripped name (legacy)
    const exactMap = new Map<string, string>()
    const refMap   = new Map<string, string>()
    const strippedMap = new Map<string, string>()

    for (const p of prods) {
      const id = toStr(p.id)
      const name = toStr(p.name)
      const ek = norm(name)
      const sk = norm(stripLeadingTag(name))
      const ref = extractRef(name)
      if (ek && !exactMap.has(ek)) exactMap.set(ek, id)
      if (ref && !refMap.has(ref)) refMap.set(ref, id)
      if (sk && !strippedMap.has(sk)) strippedMap.set(sk, id)
    }

    type Resolved = CleanRow & { product_id?: string; matched_name?: string; match_by?: 'exact'|'ref'|'stripped' }
    const resolved: Resolved[] = []
    let noMatch = 0

    for (const r of clean) {
      const incoming = toStr(r.name)
      const byExact = exactMap.get(norm(incoming))
      const ref = extractRef(incoming)
      const byRef = ref ? refMap.get(ref) : undefined
      const byStripped = strippedMap.get(norm(stripLeadingTag(incoming)))
      const pid = byExact ?? byRef ?? byStripped
      const how: 'exact'|'ref'|'stripped'|undefined = byExact ? 'exact' : (byRef ? 'ref' : (byStripped ? 'stripped' : undefined))
      if (!pid) {
        noMatch++
        reject(-1, `No matching product for "${incoming}"`)
        continue
      }
      const found = prods.find(p => toStr(p.id) === pid)
      resolved.push({
        ...r,
        product_id: pid,
        matched_name: toStr(found?.name ?? incoming),
        match_by: how!
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

    // Build payloads
    type PriceRow = { product_id: string; effective_date: string; unit_cost: number; unit_price: number }
    type InvRow   = { product_id: string; on_hand: number; backorder?: number }

    const todayISO = new Date().toISOString().slice(0, 10)
    const pricePayload: PriceRow[] = []
    const invPayload:   InvRow[]   = []

    for (const r of resolved) {
      const pid = toStr(r.product_id)
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

    // Collapse duplicates (keep last occurrence)
    const uniqPrice = Array.from(
      pricePayload.reduce((m, row) => m.set(`${row.product_id}|${row.effective_date}`, row), new Map<string, PriceRow>()).values()
    )
    const uniqInv = Array.from(
      invPayload.reduce((m, row) => m.set(row.product_id, row), new Map<string, InvRow>()).values()
    )

    // Upserts with retry & smaller batches
    let priceInserted = 0
    const priceBatches = chunk(uniqPrice, 120)
    for (let i = 0; i < priceBatches.length; i++) {
      const batch = priceBatches[i]
      const label = `upsert product_prices (batch ${i + 1}/${priceBatches.length}, rows ${batch.length})`
      const r = await callWithRetry(
        () => supabaseService.from('product_prices').upsert(batch, { onConflict: 'product_id,effective_date' }),
        label
      )
      if (r.error) {
        return res.status(502).json({
          error: 'Failed to upsert product_prices',
          detail: r.error?.message || String(r.error),
          batch: i + 1, batchRows: batch.length
        })
      }
      priceInserted += batch.length
    }

    let invInserted = 0
    const invBatches = chunk(uniqInv, 120)
    for (let i = 0; i < invBatches.length; i++) {
      const batch = invBatches[i]
      const label = `upsert inventory_current (batch ${i + 1}/${invBatches.length}, rows ${batch.length})`
      const r = await callWithRetry(
        () => supabaseService.from('inventory_current').upsert(batch, { onConflict: 'product_id' }),
        label
      )
      if (r.error) {
        return res.status(502).json({
          error: 'Failed to upsert inventory_current',
          detail: r.error?.message || String(r.error),
          batch: i + 1, batchRows: batch.length
        })
      }
      invInserted += batch.length
    }

    return res.json({
      matched_products: resolved.length,
      matched_by: {
        exact: resolved.filter(r => r.match_by === 'exact').length,
        ref: resolved.filter(r => r.match_by === 'ref').length,
        stripped: resolved.filter(r => r.match_by === 'stripped').length
      },
      price_rows: priceInserted,
      inventory_rows: invInserted,
      collapsed_duplicates: {
        product_prices: pricePayload.length - uniqPrice.length,
        inventory_current: invPayload.length - uniqInv.length
      },
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50),
      info: noMatch ? `${noMatch} row(s) could not be matched to a product.` : undefined
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/inventory/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Inventory upload failed' })
  }
})

export default router
