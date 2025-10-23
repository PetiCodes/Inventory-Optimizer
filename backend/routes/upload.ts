// backend/routes/upload.ts
import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
})

/* ---------------------------- helpers ---------------------------- */

const REQUIRED = ['date', 'customer name', 'product', 'quantity'] as const
const OPTIONAL_PRICE = 'price'

function chunk<T>(arr: T[], size = 250): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const toStr = (v: any) => (v === null || v === undefined ? '' : String(v))

const norm = (v: any) =>
  toStr(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ')

// legacy helper if some sales rows arrive without bracket tags
const stripLeadingTag = (v: any) =>
  toStr(v).replace(/^\s*\[[^\]]+\]\s*/, '').trim()

function parseQuantity(v: any): number | null {
  if (v === null || v === undefined) return null
  let s = String(v).trim()
  if (!s) return null
  if (/,/.test(s) && !/\.\d+$/.test(s) && /,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    s = s.replace(/[, ]/g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function parsePrice(v: any): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null
  let s = String(v).trim()
  if (/,/.test(s) && !/\.\d+$/.test(s) && /,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else {
    s = s.replace(/[, ]/g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function isExcelSerial(v: any): boolean {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 100000
}

function excelSerialToISO(serial: number): string | null {
  const d = xlsx.SSF.parse_date_code(serial)
  if (!d) return null
  const yyyy = String(d.y).padStart(4, '0')
  const mm = String(d.m).padStart(2, '0')
  const dd = String(d.d).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function tryParseDateString(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const d = new Date(t)
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return null
}

function sheetToAOA(buf: Buffer): any[][] {
  const wb = xlsx.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error('No sheet found')
  const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
  if (!aoa?.length) throw new Error('No data in sheet')
  return aoa
}

async function selectByNames(
  table: 'customers' | 'products',
  names: string[],
  column: 'name' | 'normalized_name' = 'name'
): Promise<{ id: string; name: string; normalized_name?: string }[]> {
  if (!names.length) return []
  const uniq = Array.from(new Set(names.filter(Boolean)))
  const parts = chunk(uniq, 300)
  const out: { id: string; name: string; normalized_name?: string }[] = []
  for (const p of parts) {
    const r = await supabaseService
      .from(table)
      .select(column === 'name' ? 'id,name' : 'id,name,normalized_name')
      .in(column, p)
    if (r.error) throw r.error
    out.push(...(r.data ?? []))
  }
  return out
}

/* ----------------------------- route ---------------------------- */

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File is required (field name must be "file")' })

    // Parse sheet
    let aoa: any[][]
    try {
      aoa = sheetToAOA(req.file.buffer)
    } catch {
      return res.status(400).json({ error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.' })
    }

    const headerRow = (aoa[0] ?? []).map(h => toStr(h))
    const toKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const idx: Record<string, number> = {}
    headerRow.forEach((h, i) => { idx[toKey(h)] = i })

    const missing = REQUIRED.filter(k => idx[k] === undefined)
    if (missing.length) {
      return res.status(400).json({
        error: 'Invalid headers. Expected: Date, Customer Name, Product, Quantity (Price optional)',
        details: { received: headerRow, missing }
      })
    }
    const hasPrice = idx[OPTIONAL_PRICE] !== undefined

    // Body rows (skip fully empty)
    const body = aoa.slice(1).filter(r => r && r.some((c: any) => toStr(c).trim() !== ''))
    if (!body.length) return res.status(400).json({ error: 'No data rows found' })

    // Clean rows
    type Clean = { Date: string; Customer: string; Product: string; Quantity: number; Price: number | null }
    const clean: Clean[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    // Forward-fill rules
    let lastCustomer: string | null = null
    let lastDateISO: string | null = null

    body.forEach((r, i) => {
      const rowNum = i + 2
      const rawDate = r[idx['date']]
      const rawCust = r[idx['customer name']]
      const rawProd = r[idx['product']]
      const rawQty  = r[idx['quantity']]
      const rawPrice = hasPrice ? r[idx[OPTIONAL_PRICE]] : undefined

      // Customer forward fill
      let customer = toStr(rawCust).trim()
      if (customer) lastCustomer = customer
      else if (lastCustomer) customer = lastCustomer

      // Date forward fill
      let dateISO: string | null = null
      if (rawDate === null || rawDate === undefined || String(rawDate).trim() === '') {
        dateISO = lastDateISO
      } else if (isExcelSerial(rawDate)) {
        dateISO = excelSerialToISO(Number(rawDate))
      } else {
        dateISO = tryParseDateString(String(rawDate))
      }
      if (dateISO) lastDateISO = dateISO

      const product = toStr(rawProd).trim()
      const qtyNum  = parseQuantity(rawQty)
      const priceNum = hasPrice ? parsePrice(rawPrice) : null

      if (!customer)       return reject(rowNum, 'Missing Customer')
      if (!dateISO)        return reject(rowNum, 'Invalid Date')
      if (!product)        return reject(rowNum, 'Missing Product')
      if (qtyNum === null) return reject(rowNum, 'Invalid Quantity')
      if (qtyNum < 0)      return reject(rowNum, 'Negative Quantity')

      clean.push({ Date: dateISO, Customer: customer, Product: product, Quantity: qtyNum, Price: priceNum })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    /* ---------- master data handling ---------- */

    // Customers: keep your original behavior (safe)
    const uniqueCustomers = Array.from(new Set(clean.map(r => r.Customer)))
    const up1 = await supabaseService
      .from('customers')
      .upsert(uniqueCustomers.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
    if (up1.error) return res.status(500).json({ error: up1.error.message })
    const custRows = await selectByNames('customers', uniqueCustomers)
    const custMap = new Map(custRows.map(c => [c.name, c.id]))

    // Products: DO NOT CREATE here (inventory should have created them already)
    const uniqueProducts = Array.from(new Set(clean.map(r => r.Product)))
    const normalizedProducts = uniqueProducts.map(p => norm(p))
    const strippedProducts = uniqueProducts.map(p => stripLeadingTag(p))

    // Fetch by exact name
    const prodExact = await selectByNames('products', uniqueProducts, 'name')
    // Fetch by normalized_name as fallback
    const prodNormRows = await selectByNames('products', Array.from(new Set(normalizedProducts)), 'normalized_name')

    // Build lookup maps
    const byExact = new Map<string, string>() // name -> id
    for (const r of prodExact) byExact.set(r.name, r.id)

    // For normalized_name we must ensure uniqueness to avoid ambiguous matches
    const normToIds = new Map<string, Set<string>>()
    for (const r of prodNormRows) {
      const key = norm(r.normalized_name ?? r.name)
      if (!normToIds.has(key)) normToIds.set(key, new Set())
      normToIds.get(key)!.add(r.id)
    }

    // Optional legacy fallback using stripped name to normalized_name
    const strippedNormToId = new Map<string, string>()
    for (const p of uniqueProducts) {
      const sn = norm(stripLeadingTag(p))
      strippedNormToId.set(sn, '') // placeholder; will fill if unique later
    }

    // resolve function
    function resolveProductId(name: string): string | undefined {
      // 1) exact name
      const exact = byExact.get(name)
      if (exact) return exact
      // 2) normalized_name unique hit
      const nn = norm(name)
      const set = normToIds.get(nn)
      if (set && set.size === 1) return Array.from(set)[0]
      // 3) legacy stripped tag (only if unique by normalized)
      const sn = norm(stripLeadingTag(name))
      const set2 = normToIds.get(sn)
      if (set2 && set2.size === 1) return Array.from(set2)[0]
      return undefined
    }

    // Build sales payload (only mapped rows)
    const salesPayload: Array<{
      date: string
      quantity: number
      unit_price: number | null
      customer_id: string
      product_id: string
    }> = []

    for (let i = 0; i < clean.length; i++) {
      const r = clean[i]
      const rowNum = i + 2
      const cid = custMap.get(r.Customer)
      const pid = resolveProductId(r.Product)

      if (!cid) {
        reject(rowNum, `Unknown Customer "${r.Customer}"`)
        continue
      }
      if (!pid) {
        reject(rowNum, `Unknown Product "${r.Product}" (not found; inventory should create products)`)
        continue
      }

      salesPayload.push({
        date: r.Date,
        quantity: r.Quantity,
        unit_price: r.Price,
        customer_id: cid,
        product_id: pid
      })
    }

    if (!salesPayload.length) {
      return res.status(400).json({
        error: 'All rows failed to map to customer/product ids',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // Insert in batches (no upsert)
    const batches = chunk(salesPayload, 250)
    let inserted = 0
    for (const b of batches) {
      const ins = await supabaseService.from('sales').insert(b, { count: 'exact' })
      if (ins.error) {
        return res.status(500).json({ error: ins.error.message, inserted })
      }
      inserted += ins.count ?? b.length
    }

    return res.json({
      inserted,
      rejectedCount: rejected.length,
      reasonCounts: Object.fromEntries(reasonCounts),
      sampleRejected: rejected.slice(0, 50)
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

export default router
