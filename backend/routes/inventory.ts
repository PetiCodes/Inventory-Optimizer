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

/** normalize simple text (lowercase, collapse whitespace) */
const norm = (v: any) =>
  toStr(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ')

/** Remove leading "[...]" tag */
const stripLeadingTag = (v: any) =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

/** Remove leading SKU/code patterns like "ABC-123 - ", "12345: ", "SKU_01 – " */
const stripLeadingCode = (v: any) =>
  toStr(v)
    // common “CODE - ” / “CODE: ” / “CODE – ”
    .replace(/^\s*([A-Za-z0-9._/#-]+)\s*[-–:]\s+/, '')
    // plain numeric code followed by space
    .replace(/^\s*[0-9]{4,}\s+/, '')
    .trim()

/** Robust number parser: handles US/EU formats, strips all unicode spaces, currency symbols */
function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let t = toStr(input).trim()
  if (!t) return null

  // strip currency symbols and any non-digit/sep characters except dot/comma/minus
  // also strip all unicode spaces (including NBSP \u00A0 and narrow NBSP \u202F)
  t = t.replace(/[\u00A0\u202F\s]/g, '') // all spaces
  t = t.replace(/[^\d.,-]/g, '')        // keep digits, dot, comma, minus

  if (!t) return null

  // If both comma and dot present, decide decimal by the one that appears last
  const lastComma = t.lastIndexOf(',')
  const lastDot = t.lastIndexOf('.')

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // comma is decimal -> remove dots (thousands), replace comma by dot
      t = t.replace(/\./g, '').replace(',', '.')
    } else {
      // dot is decimal -> remove commas (thousands)
      t = t.replace(/,/g, '')
    }
  } else if (lastComma >= 0) {
    // only comma present -> treat as decimal (EU)
    t = t.replace(/\./g, '').replace(',', '.')
  } else {
    // only dot or none -> remove any stray commas (US)
    t = t.replace(/,/g, '')
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

/* ---------------- Canonical headers (Reference is OPTIONAL) ---------------- */
const REQUIRED = ['name', 'sales price', 'cost', 'quantity on hand'] as const
type RequiredKey = (typeof REQUIRED)[number]
const ALIASES: Record<RequiredKey, string[]> = {
  'name': [],
  'sales price': ['sales price (current)'],
  'cost': [],
  'quantity on hand': ['quantity on hand (stocks)']
}
const OPTIONALS = ['reference'] as const
type OptionalKey = (typeof OPTIONALS)[number]

type CleanRow = {
  name: string
  unit_price: number
  unit_cost: number
  on_hand: number
  reference?: string | null
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
    const idx: Record<RequiredKey, number> = {
      'name': -1, 'sales price': -1, 'cost': -1, 'quantity on hand': -1
    }
    const idxOpt: Partial<Record<OptionalKey, number>> = {}

    headerRow.map(h => norm(h)).forEach((nh, i) => {
      // required
      for (const key of REQUIRED) {
        if (idx[key] !== -1) continue
        if (nh === key || ALIASES[key].includes(nh)) idx[key] = i
      }
      // optionals
      for (const ok of OPTIONALS) {
        if (idxOpt[ok] !== undefined) continue
        if (nh === ok) idxOpt[ok] = i
      }
    })

    const missing = REQUIRED.filter(k => idx[k] === -1)
    if (missing.length) {
      return res.status(400).json({
        error: 'Invalid headers. Expected: Name, Sales Price, Cost, Quantity On Hand',
        details: { received: headerRow, missing }
      })
    }

    // Rows
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
      const ref   = idxOpt['reference'] !== undefined ? toStr(r[idxOpt['reference']!]).trim() : ''

      if (!name) return reject(rowNum, 'Missing Name')
      if (price === null) return reject(rowNum, 'Invalid Sales Price')
      if (cost === null)  return reject(rowNum, 'Invalid Cost')
      if (onH === null)   return reject(rowNum, 'Invalid On Hand')

      clean.push({
        name,
        unit_price: price,
        unit_cost: cost,
        on_hand: onH,
        reference: ref || null
      })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    /* ---------------- Build in-memory maps for resolution ---------------- */

    // 1) All products (legacy name matching support)
    const allProds = await supabaseService.from('products').select('id,name')
    if (allProds.error) return res.status(500).json({ error: allProds.error.message })

    const exactMap = new Map<string,string>()
    const strippedMap = new Map<string,string>()
    const strippedHardMap = new Map<string,string>() // tag + SKU-code stripped
    for (const p of allProds.data ?? []) {
      const id = toStr(p.id)
      const name = toStr(p.name)
      const ek = norm(name)
      const sk = norm(stripLeadingTag(name))
      const hk = norm(stripLeadingCode(stripLeadingTag(name)))
      if (ek && !exactMap.has(ek)) exactMap.set(ek, id)
      if (sk && !strippedMap.has(sk)) strippedMap.set(sk, id)
      if (hk && !strippedHardMap.has(hk)) strippedHardMap.set(hk, id)
    }

    // 2) Crosswalk (reference + normalized_name)
    const xw = await supabaseService
      .from('product_lookup')
      .select('product_id, reference_code, normalized_name')
    if (xw.error) return res.status(500).json({ error: xw.error.message })

    const refMap = new Map<string, string>()       // reference_code -> product_id
    const xNormMap = new Map<string, string>()     // normalized_name -> first product_id seen
    for (const row of xw.data ?? []) {
      const pid = toStr(row.product_id)
      const rc  = toStr(row.reference_code || '')
      const nn  = toStr(row.normalized_name || '')
      if (rc) refMap.set(rc, pid)
      if (nn && !xNormMap.has(nn)) xNormMap.set(nn, pid)
    }

    /* ---------------- Resolve each clean row ---------------- */

    type Resolved = CleanRow & { product_id?: string; matched_name?: string }
    const resolved: Resolved[] = []
    const toUpsertXwalk: { product_id: string; reference_code?: string | null; normalized_name?: string | null }[] = []

    for (const r of clean) {
      const incomingName = toStr(r.name)
      const incomingRef  = r.reference ? toStr(r.reference) : ''

      const nn = norm(stripLeadingCode(stripLeadingTag(incomingName)))

      let pid: string | undefined =
        (incomingRef ? refMap.get(incomingRef) : undefined) ??
        xNormMap.get(nn) ??
        exactMap.get(norm(incomingName)) ??
        strippedMap.get(norm(stripLeadingTag(incomingName))) ??
        strippedHardMap.get(nn)

      if (!pid) {
        reject(-1, `No matching product for "${incomingName}"${incomingRef ? ` (ref: ${incomingRef})` : ''}`)
        continue
      }

      const found = (allProds.data ?? []).find(p => toStr(p.id) === pid)
      resolved.push({ ...r, product_id: pid, matched_name: toStr(found?.name ?? incomingName) })

      // Prepare crosswalk upsert so the next upload is deterministic & fast
      toUpsertXwalk.push({
        product_id: pid,
        reference_code: incomingRef || null,
        normalized_name: nn || null
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

    /* ---------------- Upsert crosswalk (by product_id) ---------------- */

    // collapse by product_id, last-one-wins, but avoid reference conflicts
    const xByPid = new Map<string, { product_id: string; reference_code?: string | null; normalized_name?: string | null }>()
    for (const x of toUpsertXwalk) xByPid.set(x.product_id, x)

    let refConflicts = 0
    const xRows = Array.from(xByPid.values()).map(x => {
      let reference_code = x.reference_code ?? undefined
      const normalized_name = x.normalized_name ?? undefined
      if (reference_code) {
        const owner = refMap.get(reference_code)
        if (owner && owner !== x.product_id) {
          reference_code = undefined // skip conflicting reference binding
          refConflicts++
        }
      }
      return {
        product_id: x.product_id,
        reference_code,
        normalized_name
      }
    })

    if (xRows.length) {
      const xUp = await supabaseService
        .from('product_lookup')
        .upsert(xRows, { onConflict: 'product_id' })
      if (xUp.error) {
        return res.status(500).json({ error: `product_lookup upsert failed: ${xUp.error.message}` })
      }
    }

    /* ---------------- Build payloads for inventory & prices ---------------- */

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

    // Dedupe prices (by product_id + date); last one wins
    const uniqPrice = Array.from(
      pricePayload.reduce(
        (m, row) => m.set(`${row.product_id}|${row.effective_date}`, row),
        new Map<string, PriceRow>()
      ).values()
    )

    // Dedupe inventory: keep the **largest** on_hand per product in this upload
    const invMap = new Map<string, InvRow>()
    for (const row of invPayload) {
      const prev = invMap.get(row.product_id)
      if (!prev || row.on_hand > prev.on_hand) {
        invMap.set(row.product_id, row)
      }
    }
    const uniqInv = Array.from(invMap.values())

    // Upserts
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
        .upsert(part, { onConflict: 'product_id' })
      if (ins2.error) return res.status(500).json({ error: ins2.error.message })
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
      ref_conflicts_skipped: refConflicts,
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
