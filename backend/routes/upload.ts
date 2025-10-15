// backend/routes/upload.ts
import { Router } from 'express'
import multer from 'multer'
import xlsx from 'xlsx'
import { supabaseService } from '../src/supabase.js' // <- keep the .js suffix for NodeNext builds

const router = Router()

// 15 MB limit is usually plenty for Excel; adjust if needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
})

// ─────────────────────────── Helpers ───────────────────────────
const REQUIRED = ['date', 'customer name', 'product', 'quantity'] as const
const OPTIONAL_PRICE = 'price'

function chunk<T>(arr: T[], size = 250): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function parseQuantity(v: any): number | null {
  if (v === null || v === undefined) return null
  let s = String(v).trim()
  if (!s) return null
  // handle “1.234,56” vs “1,234.56”
  if (/,/.test(s) && !/\.\d+$/.test(s) && /,\d+$/.test(s)) {
    s = s.replace(/\./g, '')   // thousands
    s = s.replace(',', '.')    // decimal
  } else {
    s = s.replace(/[, ]/g, '') // remove thousands
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function parsePrice(v: any): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(String(v).replace(/[, ]/g, ''))
  if (!Number.isFinite(n)) return null
  if (n < 0) return null
  return n
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t // fast path (YYYY-MM-DD)
  const d = new Date(t)
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return null
}

async function selectByNames(
  table: 'customers' | 'products',
  names: string[]
): Promise<{ id: string; name: string }[]> {
  if (!names.length) return []
  const parts = chunk(Array.from(new Set(names.filter(Boolean))), 100)
  const out: { id: string; name: string }[] = []
  for (const p of parts) {
    const r = await supabaseService.from(table).select('id,name').in('name', p)
    if (r.error) throw r.error
    out.push(...(r.data ?? []))
  }
  return out
}

// ─────────────────────────── Route ───────────────────────────
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

    // Read as AOA so we can map headers flexibly
    const aoa: any[][] = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false })
    if (!aoa?.length) return res.status(400).json({ error: 'No data found in sheet' })

    const headerRow = (aoa[0] ?? []).map(h => String(h ?? ''))

    const toKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
    const idx: Record<string, number> = {}
    headerRow.forEach((h, i) => { idx[toKey(h)] = i })

    // Check required
    const missing = REQUIRED.filter(k => idx[k] === undefined)
    if (missing.length) {
      return res.status(400).json({
        error: 'Invalid headers. Expected: Date, Customer Name, Product, Quantity (Price optional)',
        details: { received: headerRow, missing }
      })
    }
    const hasPrice = idx[OPTIONAL_PRICE] !== undefined

    // Body rows (skip fully empty)
    const body = aoa
      .slice(1)
      .filter(r => r && r.some((c: any) => c !== null && c !== undefined && String(c).trim() !== ''))
    if (!body.length) return res.status(400).json({ error: 'No data rows found' })

    type Clean = { Date: string; 'Customer Name': string; Product: string; Quantity: number; Price?: number | null }
    const clean: Clean[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    // Forward-fill Date & Customer as per your original rule
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
      let customer = String(rawCust ?? '').trim()
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

      const product = String(rawProd ?? '').trim()
      const qtyNum  = parseQuantity(rawQty)
      const priceNum = hasPrice ? parsePrice(rawPrice) : null

      if (!customer)       return reject(rowNum, 'Missing Customer')
      if (!dateISO)        return reject(rowNum, 'Invalid Date')
      if (!product)        return reject(rowNum, 'Missing Product')
      if (qtyNum === null) return reject(rowNum, 'Invalid Quantity')
      if (qtyNum < 0)      return reject(rowNum, 'Negative Quantity')
      // price is optional; if present but invalid we’ll just ignore it

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

    // Upsert master data first
    const uniqueCustomers = Array.from(new Set(clean.map(r => r['Customer Name'])))
    const uniqueProducts  = Array.from(new Set(clean.map(r => r['Product'])))

    const up1 = await supabaseService
      .from('customers')
      .upsert(uniqueCustomers.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
    if (up1.error) {
      console.error('customers upsert error:', up1.error)
      return res.status(500).json({ error: up1.error.message })
    }

    const up2 = await supabaseService
      .from('products')
      .upsert(uniqueProducts.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
    if (up2.error) {
      console.error('products upsert error:', up2.error)
      return res.status(500).json({ error: up2.error.message })
    }

    // Map names -> ids
    let custRows: { id: string; name: string }[] = []
    let prodRows: { id: string; name: string }[] = []
    try {
      custRows = await selectByNames('customers', uniqueCustomers)
      prodRows = await selectByNames('products', uniqueProducts)
    } catch (err: any) {
      console.error('selectByNames error:', err)
      return res.status(500).json({ error: err?.message || 'Lookup failed' })
    }
    const custMap = new Map(custRows.map(c => [c.name, c.id]))
    const prodMap = new Map(prodRows.map(p => [p.name, p.id]))

    // Build sales payload
    const salesPayload = clean
      .map(r => ({
        date: r.Date,
        quantity: r.Quantity,
        unit_price: r.Price ?? null,
        customer_id: custMap.get(r['Customer Name']),
        product_id: prodMap.get(r['Product'])
      }))
      .filter(x => x.customer_id && x.product_id)

    if (!salesPayload.length) {
      return res.status(400).json({
        error: 'All rows failed to map to customer/product ids',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // Insert in batches (avoid timeouts)
    const batches = chunk(salesPayload, 250)
    let inserted = 0
    for (const b of batches) {
      const ins = await supabaseService.from('sales').insert(b, { count: 'exact' })
      if (ins.error) {
        console.error('sales insert error:', ins.error)
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
