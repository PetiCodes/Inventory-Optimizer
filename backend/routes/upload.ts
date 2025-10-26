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
const stripBOM = (s: string) => s.replace(/^\uFEFF/, '')
const collapseSpaces = (s: string) => s.replace(/\s+/g, ' ')

/** Normalize product names for matching */
function canonName(raw: any): string {
  const t = stripBOM(toStr(raw)).trim()
  const normBrackets = t.replace(/^\s*[［\[]([^］\]]+)[］\]]\s*/, '[$1] ')
  return collapseSpaces(normBrackets)
}

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
  names: string[]
): Promise<{ id: string; name: string }[]> {
  if (!names.length) return []
  const uniq = Array.from(new Set(names.filter(Boolean)))
  const parts = chunk(uniq, 100)
  const out: { id: string; name: string }[] = []
  for (const p of parts) {
    const r = await supabaseService.from(table).select('id,name').in('name', p)
    if (r.error) throw r.error
    out.push(...(r.data ?? []))
  }
  return out
}

/** Fetch ALL products from database with pagination */
async function fetchAllProducts(): Promise<Array<{ id: string; name: string }>> {
  const pageSize = 1000
  let from = 0
  let all: Array<{ id: string; name: string }> = []
  
  while (true) {
    const to = from + pageSize - 1
    const r = await supabaseService.from('products').select('id,name').range(from, to)
    if (r.error) throw r.error
    const batch = (r.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name) }))
    all = all.concat(batch)
    if (batch.length < pageSize) break
    from += pageSize
    await new Promise(res => setTimeout(res, 3))
  }
  return all
}

/** Advanced product matching with multiple strategies */
function findBestProductMatch(productName: string, prodMap: Map<string, string>, exactProdMap: Map<string, string>, strippedProdMap: Map<string, string>): string | undefined {
  // Try 1: Exact match
  if (prodMap.has(productName)) return prodMap.get(productName)
  
  // Try 2: Normalized canonical match
  const cName = canonName(productName)
  if (exactProdMap.has(cName)) return exactProdMap.get(cName)
  
  // Try 3: Strip leading tags and match
  const cStrip = canonName(stripLeadingTag(productName))
  const byStrip = exactProdMap.get(cStrip) || strippedProdMap.get(cStrip)
  if (byStrip) return byStrip
  
  // Try 4: Match ignoring "archived" and parentheses
  const cleanArchived = productName.replace(/^\s*\(Archived\)\s*/i, '').trim()
  if (cleanArchived !== productName) {
    return findBestProductMatch(cleanArchived, prodMap, exactProdMap, strippedProdMap)
  }
  
  // Try 5: Case insensitive match on normalized name
  const lowerCName = cName.toLowerCase()
  for (const [key, id] of exactProdMap.entries()) {
    if (key.toLowerCase() === lowerCName) return id
  }
  
  return undefined
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
    type Clean = { rowNum: number; Date: string; Customer: string; Product: string; Quantity: number; Price: number | null }
    const clean: Clean[] = []
    const rejected: { row: number; reason: string }[] = []
    const reasonCounts = new Map<string, number>()
    const reject = (row: number, reason: string) => {
      rejected.push({ row, reason })
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)
    }

    body.forEach((r, i) => {
      const rowNum = i + 2
      const rawDate = r[idx['date']]
      const rawCust = r[idx['customer name']]
      const rawProd = r[idx['product']]
      const rawQty  = r[idx['quantity']]
      const rawPrice = hasPrice ? r[idx[OPTIONAL_PRICE]] : undefined

      // Parse date - all rows must have a date (no auto-fill)
      let dateISO: string | null = null
      if (rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== '') {
        if (isExcelSerial(rawDate)) {
          dateISO = excelSerialToISO(Number(rawDate))
        } else {
          dateISO = tryParseDateString(String(rawDate))
        }
      }

      const customer = toStr(rawCust).trim()
      const product = toStr(rawProd).trim()
      const qtyNum  = parseQuantity(rawQty)
      const priceNum = hasPrice ? parsePrice(rawPrice) : null

      if (!customer)       return reject(rowNum, 'Missing Customer Name')
      if (!dateISO)        return reject(rowNum, 'Missing or Invalid Date')
      if (!product)        return reject(rowNum, 'Missing Product')
      if (qtyNum === null) return reject(rowNum, 'Invalid Quantity')
      if (qtyNum < 0)      return reject(rowNum, 'Negative Quantity')

      clean.push({ rowNum, Date: dateISO, Customer: customer, Product: product, Quantity: qtyNum, Price: priceNum })
    })

    if (!clean.length) {
      return res.status(400).json({
        error: 'No valid rows to import',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // Upsert master data (customers/products) in small chunks
    const uniqueCustomers = Array.from(new Set(clean.map(r => r.Customer)))
    const uniqueProducts  = Array.from(new Set(clean.map(r => r.Product)))

    // Create customers
    for (const part of chunk(uniqueCustomers, 200)) {
      const up1 = await supabaseService
        .from('customers')
        .upsert(part.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
      if (up1.error) return res.status(500).json({ error: up1.error.message })
    }
    
    // First, fetch ALL existing products from database to match against
    const allExistingProducts = await fetchAllProducts()
    
    // Build product maps for matching
    const prodMapForMatch = new Map<string, string>()
    const exactProdMapForMatch = new Map<string, string>()
    const strippedProdMapForMatch = new Map<string, string>()
    
    for (const p of allExistingProducts) {
      const id = p.id
      const nm = p.name
      const cExact = canonName(nm)
      const cStrip = canonName(stripLeadingTag(nm))
      
      if (cExact && !exactProdMapForMatch.has(cExact)) {
        exactProdMapForMatch.set(cExact, id)
        prodMapForMatch.set(nm, id)
      }
      if (cStrip && !strippedProdMapForMatch.has(cStrip)) {
        strippedProdMapForMatch.set(cStrip, id)
      }
    }
    
    // Find which products need to be created (don't match existing products)
    const productsToCreate: string[] = []
    for (const productName of uniqueProducts) {
      const match = findBestProductMatch(productName, prodMapForMatch, exactProdMapForMatch, strippedProdMapForMatch)
      if (!match) {
        productsToCreate.push(productName)
      }
    }
    
    // Only create products that don't exist
    if (productsToCreate.length > 0) {
      for (const part of chunk(productsToCreate, 200)) {
        const up2 = await supabaseService
          .from('products')
          .upsert(part.map(name => ({ name })), { onConflict: 'name', ignoreDuplicates: true })
        if (up2.error) return res.status(500).json({ error: up2.error.message })
      }
      // Brief delay to ensure DB consistency
      await new Promise(res => setTimeout(res, 100))
      
      // Re-fetch products to include newly created ones
      const updatedProducts = await fetchAllProducts()
      allExistingProducts.push(...updatedProducts.filter(p => productsToCreate.includes(p.name)))
    }
    
    // Final product list with all products (existing + newly created)
    const prodRows = await fetchAllProducts()
    
    // Re-build maps after creating new products (in case they were created)
    const prodMap = new Map<string, string>()
    const exactProdMap = new Map<string, string>()
    const strippedProdMap = new Map<string, string>()
    
    for (const p of prodRows) {
      const id = p.id
      const nm = p.name
      const cExact = canonName(nm)
      const cStrip = canonName(stripLeadingTag(nm))
      
      if (cExact && !exactProdMap.has(cExact)) {
        exactProdMap.set(cExact, id)
        prodMap.set(nm, id) // exact name
      }
      if (cStrip && !strippedProdMap.has(cStrip)) {
        strippedProdMap.set(cStrip, id)
      }
    }
    
    // Map names → ids for customers
    const custRows = await selectByNames('customers', uniqueCustomers)
    
    // Build customer map with exact and normalized keys
    const custMap = new Map<string, string>()
    for (const c of custRows) {
      const normalized = c.name.trim().toLowerCase()
      if (!custMap.has(normalized)) {
        custMap.set(c.name, c.id) // exact match
        custMap.set(normalized, c.id) // normalized match
      }
    }
    
    // Helper functions
    const findCustomerId = (name: string): string | undefined => {
      return custMap.get(name) || custMap.get(name.trim().toLowerCase())
    }
    
    const findProductId = (name: string): string | undefined => {
      return findBestProductMatch(name, prodMap, exactProdMap, strippedProdMap)
    }

    // Build sales payload and track unmapped rows
    const salesPayload = clean
      .map((r) => {
        const customer_id = findCustomerId(r.Customer)
        const product_id = findProductId(r.Product)
        
        // Track unmapped issues
        if (!customer_id) {
          reject(r.rowNum, `Customer not found in database: "${r.Customer}"`)
        }
        if (!product_id) {
          reject(r.rowNum, `Product not found in database: "${r.Product}"`)
        }
        
        return customer_id && product_id ? {
          date: r.Date,
          quantity: r.Quantity,
          unit_price: r.Price, // may be null
          customer_id: customer_id,
          product_id: product_id
        } : null
      })
      .filter(x => x !== null) as Array<{
        date: string; quantity: number; unit_price: number | null; customer_id: string; product_id: string;
      }>

    if (!salesPayload.length) {
      return res.status(400).json({
        error: 'All rows failed to map to customer/product ids',
        rejectedCount: rejected.length,
        reasonCounts: Object.fromEntries(reasonCounts),
        sampleRejected: rejected.slice(0, 50)
      })
    }

    // Insert in batches
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
      sampleRejected: rejected.slice(0, 100), // Show first 100 rejected rows
      totalRowsProcessed: body.length,
      acceptedRows: clean.length,
      finalInserted: inserted
    })
  } catch (e: any) {
    console.error('UNHANDLED /api/upload error:', e)
    return res.status(500).json({ error: e?.message || 'Upload failed' })
  }
})

export default router
