import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

// ───────────────────────────────────────── Helpers ─────────────────────────────────────────
const norm = (s: any) =>
  String(s ?? '')
    .replace(/^\uFEFF/, '') // strip BOM
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')

const REQUIRED = ['date', 'customer name', 'product', 'quantity'] as const

function chunk<T>(arr: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function selectByNames(
  table: 'customers' | 'products',
  names: string[]
): Promise<{ id: string; name: string }[]> {
  if (!names.length) return []
  const parts = chunk(Array.from(new Set(names.filter(n => !!n))), 100)
  const all: { id: string; name: string }[] = []
  for (const p of parts) {
    const q = await supabaseService.from(table).select('id,name').in('name', p)
    if (q.error) {
      console.error(`${table} select chunk error:`, q.error, 'chunk size:', p.length)
      throw q.error
    }
    all.push(...(q.data ?? []))
  }
  return all
}

// Numbers: accept 1,234 / 1 234 / 1.234,56 / 1234.56
function parseNumber(input: any): number | null {
  if (input === null || input === undefined) return null
  let s = String(input).trim()
  if (s === '') return null
  if (/,/.test(s) && !/\.\d+$/.test(s) && /,\d+$/.test(s)) {
    s = s.replace(/\./g, '')   // thousands sep
    s = s.replace(',', '.')    // decimal sep
  } else {
    s = s.replace(/[, ]/g, '') // remove commas/spaces thousands
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function isExcelSerial(v: any): boolean {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 100000
}

function tryParseDateString(s: string): string | null {
  const t = s.trim()
  if (!t) return null

  // Fast-path for ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t

  // Fallback: general Date parse
  const d = new Date(t)
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return null
}

function excelSerialToISO(serial: number): string | null {
  const d = xlsx.SSF.parse_date_code(serial)
  if (!d) return null
  const yyyy = String(d.y).padStart(4, '0')
  const mm = String(d.m).padStart(2, '0')
  const dd = String(d.d).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// ───────────────────────────────────────── Route ─────────────────────────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File is required (field name must be "file")' })

    // Parse workbook
    let ws
    try {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' })
      const sheetName = wb.SheetNames[0]
      ws = wb.Sheets[sheetName]
      if (!ws) return res.status(400).json({ error: 'No sheet found in workbook' })
    } catch (e) {
      console.error('Parse error:', e)
      return res.status(400).json({ error: 'Unable to parse file. Use .xlsx/.xls/.csv with headers.' })
    }

    // AOA for tolerant header mapping
    const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
    if (!aoa?.length) return res.status(400).json({ error: 'No data found in sheet' })

    const headerRow = (aoa[0] ?? []).map(h => String(h ?? ''))
    if (!headerRow.length) return res.status(400).json({ error: 'Header row missing' })

    // Build header index map (case/space-insensitive)
    const idxMap: Record<typeof REQUIRED[number], number> = { date: -1, 'customer name': -1, product: -1, quantity: -1 }
    const optional = {
      price: -1, // optional Price / Sales Price / Unit Price
    }

    headerRow.forEach((h, i) => {
      const nh = norm(h)
      REQUIRED.forEach(req => {
        if (idxMap[req] === -1 && nh === req) idxMap[req] = i
      })
      if (optional.price === -1 && (nh === 'price' || nh === 'sales price' || nh === 'unit price')) optional.price = i
    })

    const missing = REQUIRED.filter(k => idxMap[k] === -1)
    if (missing.length) {
      return res.status(400).json({
        error: `Invalid headers. Expected: Date, Customer Name, Product, Quantity (+ optional Price)`,
        details: { received: headerRow, missing }
      })
    }

    // Body rows (skip completely empty)
    const bodyRows = aoa
      .slice(1)
      .filter(r => r && r.some((c: any) => c !== null && c !== undefined && String(c).trim() !== ''))
    if (!bodyRows.length) return res.status(400).json({ error: 'No data rows found' })

    type CleanRow = {
      Date: string
      'Customer Name': string
      Product: string
      Quantity: number
      Price: number | null
    }
    const clean: CleanRow[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()

    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    // Forward-fill: Customer and Date
    let lastCustomer: string | null = null
    let lastDateISO: string | null = null

    bodyRows.forEach((r, i) => {
      const rowNum = i + 2
      const rawDate = r[idxMap['date']]
      const rawCust = r[idxMap['customer name']]
      const rawProd = r[idxMap['product']]
      const rawQty  = r[idxMap['quantity']]
      const rawPrice = optional.price !== -1 ? r[optional.price] : null

      // Customer forward fill
      let customer = String(rawCust ?? '').trim()
      if (customer) lastCustomer = customer
      else if (lastCustomer) customer = lastCustomer

      // Date forward fill
      let dateISO: string | null = null
      if (rawDate === null || rawDate === undefined || String(rawDate).trim() === '') {
        dateISO = lastDateISO // use previous non-empty date
      } else if (isExcelSerial(rawDate)) {
        dateISO = excelSerialToISO(Number(rawDate))
      } else {
        dateISO = tryParseDateString(String(rawDate))
      }
      if (dateISO) lastDateISO = dateISO

      const product = String(rawProd ?? '').trim()
      const qtyNum  = parseNumber(rawQty)
      const priceNum = rawPrice !== null && rawPrice !== undefined ? parseNumber(rawPrice) : null

      if (!customer)            return reject(rowNum, 'Missing Customer')
      if (!dateISO)             return reject(rowNum, 'Invalid Date')      // after forward-fill
      if (!product)             return reject(rowNum, 'Missing Product')
      if (qtyNum === null)      return reject(rowNum, 'Invalid Quantity')
      if (qtyNum < 0)           return reject(rowNum, 'Negative Quantity')

      clean.push({ Date: dateISO, 'Customer Name': customer, Product: product, Quantity: qtyNum, Price: priceNum })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    const uniqueCustomers = Array.from(new Set(clean.map(r => r['Customer Name'])))
    const uniqueProducts  = Array.from(new Set(clean.map(r => r['Product'])))

    // Upserts
    const up1 = await supabaseService
      .from('customers')
      .upsert(uniqueCustomers.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
    if (up1.error) { console.error('customers upsert error:', up1.error); return res.status(500).json({ error: up1.error.message }) }

    const up2 = await supabaseService
      .from('products')
      .upsert(uniqueProducts.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
    if (up2.error) { console.error('products upsert error:', up2.error); return res.status(500).json({ error: up2.error.message }) }

    // Chunked selects
    let custRows: { id: string; name: string }[] = []
    let prodRows: { id: string; name: string }[] = []
    try { custRows = await selectByNames('customers', uniqueCustomers) }
    catch (e: any) { console.error('customers select error (chunked):', e); return res.status(500).json({ error: e.message || 'Customer select failed' }) }
    try { prodRows = await selectByNames('products', uniqueProducts) }
    catch (e: any) { console.error('products select error (chunked):', e); return res.status(500).json({ error: e.message || 'Product select failed' }) }

    const custMap = new Map(custRows.map(c => [c.name, c.id]))
    const prodMap = new Map(prodRows.map(p => [p.name, p.id]))

    const salesPayload = clean.map(r => ({
      date: r.Date,
      quantity: r.Quantity,
      customer_id: custMap.get(r['Customer Name']),
      product_id: prodMap.get(r['Product']),
      unit_price: r.Price   // may be null; column must exist in sales
    })).filter(x => x.customer_id && x.product_id)

    if (!salesPayload.length) {
      return res.status(400).json({
        error: 'All rows failed to map to customer/product ids',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    const ins = await supabaseService.from('sales').insert(salesPayload, { count: 'exact' })
    if (ins.error) { console.error('sales insert error:', ins.error); return res.status(500).json({ error: ins.error.message }) }

    return res.json({
      inserted: ins.count ?? salesPayload.length,
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
