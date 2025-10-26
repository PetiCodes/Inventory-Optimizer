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

/** Normalize leading brackets to ASCII [..], keep them, then trim + collapse spaces */
function canonName(raw: any): string {
  const t = stripBOM(toStr(raw)).trim()
  const normBrackets = t.replace(/^\s*[［\[]([^］\]]+)[］\]]\s*/, '[$1] ')
  return collapseSpaces(normBrackets)
}

/** Legacy safety (fallback key only) */
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

/* ------------------ PostgREST-safe pagination helpers ------------------ */

async function fetchAllProducts(): Promise<Array<{ id: string; name: string }>> {
  const pageSize = 1000 // PostgREST default cap
  let from = 0
  let all: Array<{ id: string; name: string }> = []

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const to = from + pageSize - 1
    const r = await supabaseService
      .from('products')
      .select('id,name')
      .range(from, to)

    if (r.error) throw r.error
    const batch = (r.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name) }))
    all = all.concat(batch)
    if (batch.length < pageSize) break
    from += pageSize
    // small yield to avoid “fetch failed” bursts
    await sleep(3)
  }
  return all
}

/* --------------------------- route --------------------------- */

/**
 * Inventory Upload Endpoint
 * 
 * Behavior:
 * - Duplicate Prevention: Products are matched using normalized names before creation.
 *   If an uploaded product matches an existing product (by name or stripped name), the
 *   existing product is used and NO duplicate is created.
 * 
 * - First upload: Creates new products, sets prices with today's date, updates inventory
 * 
 * - Re-upload of existing products:
 *   1. Existing products are matched by name and their values are updated
 *   2. Updates the most recent price entry (not creates new daily entry)
 *   3. NO duplicate products are created
 * 
 * - New products in re-upload: Only truly new products are created with today's date
 * 
 * - Inventory is always updated for all matched products
 */
router.post('/inventory/upload', upload.single('file'), async (req, res) => {
  const stage = {
    parse: false,
    upsertProducts: 0,
    builtAgg: 0,
    fetchedProducts: 0,
    priceBatches: 0,
    invBatches: 0
  }
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

    // Aggregate duplicates by Name (sum on_hand, keep last non-null price/cost)
    type AggRow = { name: string; unit_price: number; unit_cost: number; on_hand: number }
    const agg = new Map<string, AggRow>()
    for (const r of rawClean) {
      const key = r.name
      const prev = agg.get(key)
      if (!prev) {
        agg.set(key, { ...r })
      } else {
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

    // **Step 1: Fetch ALL existing products first (with pagination)**
    const allProducts = await fetchAllProducts()
    stage.fetchedProducts = allProducts.length

    // Build mapping keys for matching
    const exactMap = new Map<string, string>()
    const strippedMap = new Map<string, string>()
    const normalizedToOriginal = new Map<string, string>() // Store original DB names
    
    for (const p of allProducts) {
      const id = p.id
      const nm = p.name
      const cExact = canonName(nm)
      const cStrip = canonName(stripLeadingTag(nm))
      if (cExact && !exactMap.has(cExact)) {
        exactMap.set(cExact, id)
        normalizedToOriginal.set(cExact, nm)
      }
      if (cStrip && !strippedMap.has(cStrip)) {
        strippedMap.set(cStrip, id)
      }
    }

    // **Step 2: Match uploaded products to existing products**
    const uploadedProducts = new Map<string, { id: string; name: string }>()
    const productsToCreate: string[] = []
    
    for (const r of clean) {
      // Try to find existing product using matching logic
      const cName = canonName(r.name)
      const cStrip = canonName(stripLeadingTag(r.name))
      
      const byExact = exactMap.get(cName)
      const byStrip = exactMap.get(cStrip) || strippedMap.get(cStrip)
      const pid = byExact || byStrip
      
      if (pid) {
        // Product already exists - don't create it
        uploadedProducts.set(r.name, { id: pid, name: r.name })
      } else {
        // Product doesn't exist - will need to create it
        productsToCreate.push(r.name)
      }
    }

    // **Step 3: Create only products that don't exist yet**
    if (productsToCreate.length > 0) {
      for (const part of chunk(productsToCreate, 75)) {
        const up = await supabaseService
          .from('products')
          .upsert(part.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
        if (up.error) return res.status(500).json({ error: up.error.message, stage, step: 'upsert_products' })
        stage.upsertProducts += part.length
        await sleep(5)
      }
      
      // Fetch the newly created products and add them to uploadedProducts
      const newProducts = await supabaseService
        .from('products')
        .select('id, name')
        .in('name', productsToCreate)
      
      if (!newProducts.error && newProducts.data) {
        for (const p of newProducts.data) {
          uploadedProducts.set(String(p.name), { id: String(p.id), name: String(p.name) })
        }
      }
    }

    // **Step 4: Build mapping: product_id -> most_recent_effective_date for existing products**
    const allProductIds = Array.from(uploadedProducts.values()).map(p => p.id)

    // Fetch existing prices for all products in batch
    // Note: PostgREST doesn't support window functions, so we fetch all prices and process in JS
    const existingPricesMap = new Map<string, string>()
    const productIdsArray = Array.from(allProductIds)
    for (const part of chunk(productIdsArray, 500)) {
      const existingPrices = await supabaseService
        .from('product_prices')
        .select('product_id, effective_date')
        .in('product_id', part)

      if (existingPrices.data) {
        // Group by product_id and keep the most recent date
        for (const row of existingPrices.data) {
          const pid = String(row.product_id)
          const date = String(row.effective_date)
          const existing = existingPricesMap.get(pid)
          if (!existing || date > existing) {
            existingPricesMap.set(pid, date)
          }
        }
      }
      await sleep(3)
    }

    // Build payloads
    type PriceRow = { product_id: string; effective_date: string; unit_cost: number; unit_price: number }
    type InvRow   = { product_id: string; on_hand: number; backorder?: number }

    const todayISO = new Date().toISOString().slice(0, 10)
    const pricePayload: PriceRow[] = []
    const invPayload:   InvRow[]   = []

    const unmatched: string[] = []

    // **Step 5: Build payloads using the matched products**
    for (const r of clean) {
      const product = uploadedProducts.get(r.name)
      if (!product) {
        unmatched.push(r.name)
        continue
      }

      const pid = product.id
      const unit_cost  = Number.isFinite(Number(r.unit_cost))  ? Number(r.unit_cost)  : 0
      const unit_price = Number.isFinite(Number(r.unit_price)) ? Number(r.unit_price) : 0
      const on_hand    = Number.isFinite(Number(r.on_hand))    ? Number(r.on_hand)    : 0

      // Use existing effective_date if product already has prices, otherwise use today
      const effectiveDate = existingPricesMap.get(pid) || todayISO
      
      pricePayload.push({ product_id: pid, effective_date: effectiveDate, unit_cost, unit_price })
      invPayload.push({ product_id: pid, on_hand, backorder: 0 })
    }

    // Dedupe final payloads
    const uniqPrice = Array.from(
      pricePayload.reduce((m, row) => m.set(`${row.product_id}|${row.effective_date}`, row), new Map<string, PriceRow>()).values()
    )
    const uniqInv = Array.from(
      invPayload.reduce((m, row) => {
        const existing = m.get(row.product_id)
        if (!existing) m.set(row.product_id, row)
        else m.set(row.product_id, { ...row, on_hand: (existing.on_hand || 0) + (row.on_hand || 0) })
        return m
      }, new Map<string, InvRow>()).values()
    )

    // Upserts
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

    // Verify & retry
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
