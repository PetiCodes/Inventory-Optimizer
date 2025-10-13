import React, { useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader, CardFooter } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import { useToast } from '../components/ToastProvider'
import { supabase } from '../lib/supabaseClient'

type SalesPreviewRow = {
  Date: string
  'Customer Name': string
  Product: string
  Quantity: string | number
  Price: string | number
}

type InventoryPreviewRow = {
  Product: string
  'On Hand'?: string | number
  'Quantity on Hand'?: string | number
  Cost?: string | number
  Price?: string | number
}

const SALES_HEADERS = ['Date', 'Customer Name', 'Product', 'Quantity', 'Price'] as const
const INVENTORY_HEADERS_NOTE = 'Name (Product), Sales Price (Current), Cost, Quantity On Hand'

type Tab = 'sales' | 'inventory'

export default function DataUpload() {
  const [active, setActive] = useState<Tab>('sales')

  // Sales state
  const [salesFile, setSalesFile] = useState<File | null>(null)
  const [salesRows, setSalesRows] = useState<SalesPreviewRow[]>([])
  const [salesErrors, setSalesErrors] = useState<string[]>([])
  const [salesSummary, setSalesSummary] = useState<any | null>(null)
  const [salesUploading, setSalesUploading] = useState(false)

  // Inventory state
  const [invFile, setInvFile] = useState<File | null>(null)
  const [invRows, setInvRows] = useState<InventoryPreviewRow[]>([])
  const [invErrors, setInvErrors] = useState<string[]>([])
  const [invSummary, setInvSummary] = useState<any | null>(null)
  const [invUploading, setInvUploading] = useState(false)

  const { addToast } = useToast()

  // ───────────── helpers ─────────────
  function readCSVPreview(file: File, mode: Tab) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = String(reader.result || '')
        const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
        if (!lines.length) return
        const headers = lines[0].split(',').map(h => h.trim())

        if (mode === 'sales') {
          const valid =
            SALES_HEADERS.length === headers.length &&
            SALES_HEADERS.every((h, i) => headers[i] === h)

          if (!valid) {
            setSalesErrors(['Invalid headers. Expected: ' + SALES_HEADERS.join(', ')])
            setSalesRows([])
            return
          }

          const parsed = lines.slice(1).slice(0, 20).map(line => {
            const cells = line.split(',')
            return {
              Date: cells[0],
              'Customer Name': cells[1],
              Product: cells[2],
              Quantity: cells[3],
              Price: cells[4],
            } as SalesPreviewRow
          })
          setSalesRows(parsed)
          setSalesErrors([])
        } else {
          // inventory mode: tolerant headers, just preview; backend does real validation
          const lh = headers.map(h => h.toLowerCase())
          const idx = {
            name: lh.findIndex(h => h === 'name' || h === 'product' || h === 'product name'),
            onhand: lh.findIndex(h => ['on hand', 'quantity on hand', 'qty on hand', 'stock', 'quantity'].includes(h)),
            cost: lh.findIndex(h => ['cost', 'unit cost', 'purchase cost', 'cost price'].includes(h)),
            price: lh.findIndex(h => ['price', 'sales price (current)', 'sales price', 'unit price', 'selling price'].includes(h)),
          }
          if (idx.name === -1 || idx.onhand === -1) {
            setInvErrors([`Invalid headers. Required at least: Name/Product and On Hand/Quantity on Hand. (${INVENTORY_HEADERS_NOTE})`])
            setInvRows([])
            return
          }

          const parsed = lines.slice(1).slice(0, 20).map(line => {
            const cells = line.split(',')
            const row: InventoryPreviewRow = {
              Product: cells[idx.name] ?? ''
            }
            if (idx.onhand !== -1) row['On Hand'] = cells[idx.onhand]
            if (idx.cost !== -1) row.Cost = cells[idx.cost]
            if (idx.price !== -1) row.Price = cells[idx.price]
            return row
          })
          setInvRows(parsed)
          setInvErrors([])
        }
      } catch {
        if (mode === 'sales') setSalesErrors(['Failed to read CSV preview'])
        else setInvErrors(['Failed to read CSV preview'])
      }
    }
    reader.readAsText(file)
  }

  function onSalesFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setSalesFile(f)
    setSalesRows([])
    setSalesErrors([])
    setSalesSummary(null)
    if (!f) return

    const name = f.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
      setSalesErrors(['Unsupported file type. Use .xlsx, .xls, or .csv'])
      return
    }
    if (name.endsWith('.csv')) {
      readCSVPreview(f, 'sales')
    } else {
      // For xlsx/xls — skip client preview; backend will validate & parse
      setSalesRows([])
    }
  }

  function onInvFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setInvFile(f)
    setInvRows([])
    setInvErrors([])
    setInvSummary(null)
    if (!f) return

    const name = f.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
      setInvErrors(['Unsupported file type. Use .xlsx, .xls, or .csv'])
      return
    }
    if (name.endsWith('.csv')) {
      readCSVPreview(f, 'inventory')
    } else {
      // For xlsx/xls — skip client preview; backend will validate & parse
      setInvRows([])
    }
  }

  async function uploadSales() {
    if (!salesFile) { 
      addToast('Please choose a sales file', 'warning'); 
      return 
    }
  
    setSalesUploading(true)
    setSalesSummary(null)
  
    try {
      const fd = new FormData()
      fd.append('file', salesFile)
  
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/upload`, {
        method: 'POST',
        body: fd
      })
  
      const data = await res.json()
      setSalesSummary(data)
  
      if (!res.ok) {
        addToast(data?.error || 'Sales upload failed', 'error')
      } else {
        addToast(`Imported ${data.inserted} rows. Rejected ${data.rejectedCount}.`, 'success')
      }
    } catch (e: any) {
      addToast(e.message || 'Sales upload failed', 'error')
    } finally {
      setSalesUploading(false)
    }
  }
  
  async function uploadInventory() {
    if (!invFile) { 
      addToast('Please choose an inventory file', 'warning'); 
      return 
    }
  
    setInvUploading(true)
    setInvSummary(null)
  
    try {
      const fd = new FormData()
      fd.append('file', invFile)
  
      const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}/api/inventory/upload`, {
        method: 'POST',
        body: fd
      })
  
      const data = await res.json()
      setInvSummary(data)
  
      if (!res.ok) {
        addToast(data?.error || 'Inventory upload failed', 'error')
      } else {
        addToast(
          `Inventory updated for ${data.inventory_rows} rows, prices added: ${data.price_rows}.`, 
          'success'
        )
      }
    } catch (e: any) {
      addToast(e.message || 'Inventory upload failed', 'error')
    } finally {
      setInvUploading(false)
    }
  }

  function switchTab(tab: Tab) {
    setActive(tab)
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Data Upload</h1>
          <p className="text-gray-600">Upload Sales and Inventory files. Both accept .xlsx, .xls, or .csv.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          <Button variant={active === 'sales' ? 'primary' : 'secondary'} onClick={() => switchTab('sales')}>
            Sales Upload
          </Button>
          <Button variant={active === 'inventory' ? 'primary' : 'secondary'} onClick={() => switchTab('inventory')}>
            Inventory Upload
          </Button>
        </div>

        {/* SALES CARD */}
        {active === 'sales' && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-gray-900">Upload Sales File</h3>
              <p className="text-sm text-gray-600">
                Required CSV headers: <code>{SALES_HEADERS.join(', ')}</code>
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={onSalesFileChange}
                className="block w-full text-sm text-gray-700
                           file:mr-4 file:py-2 file:px-4
                           file:rounded-lg file:border-0
                           file:text-sm file:font-semibold
                           file:bg-primary-50 file:text-primary-700
                           hover:file:bg-primary-100"
              />
              {salesErrors.length > 0 && (
                <Alert variant="error">
                  {salesErrors.map((e, i) => <div key={i}>{e}</div>)}
                </Alert>
              )}
              {salesFile && salesFile.name.match(/\.(xlsx|xls)$/i) && (
                <Alert variant="info">Preview for .xlsx is not shown; the server will validate and parse.</Alert>
              )}
            </CardContent>
            <CardFooter className="flex justify-end">
              <Button onClick={uploadSales} disabled={salesUploading || !salesFile}>
                {salesUploading ? 'Uploading…' : 'Upload Sales'}
              </Button>
            </CardFooter>

            {salesRows.length > 0 && (
              <CardContent>
                <div className="mt-4 border-t pt-4">
                  <h4 className="text-md font-semibold text-gray-900 mb-2">Preview (first 20 rows)</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Customer Name</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Quantity</TableHead>
                        <TableHead>Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {salesRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.Date}</TableCell>
                          <TableCell>{r['Customer Name']}</TableCell>
                          <TableCell>{r.Product}</TableCell>
                          <TableCell>{r.Quantity}</TableCell>
                          <TableCell>{r.Price}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}

            {salesSummary?.reasonCounts && (
              <CardContent>
                <Alert variant="warning">
                  <div className="font-semibold mb-2">Rejected rows breakdown</div>
                  <ul className="list-disc ml-6 space-y-1">
                    {Object.entries(salesSummary.reasonCounts).map(([k, v]) => (
                      <li key={k}>{k}: {v as number}</li>
                    ))}
                  </ul>
                  {salesSummary.sampleRejected?.length > 0 && (
                    <div className="mt-2 text-sm text-gray-700">
                      Showing first {salesSummary.sampleRejected.length} rejected rows with reasons.
                    </div>
                  )}
                </Alert>
              </CardContent>
            )}
          </Card>
        )}

        {/* INVENTORY CARD */}
        {active === 'inventory' && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-gray-900">Upload Inventory File</h3>
              <p className="text-sm text-gray-600">
                Expected columns: <code>{INVENTORY_HEADERS_NOTE}</code><br/>
                Names with/without codes like <code>[12345] Product Name</code> are auto-matched.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={onInvFileChange}
                className="block w-full text-sm text-gray-700
                           file:mr-4 file:py-2 file:px-4
                           file:rounded-lg file:border-0
                           file:text-sm file:font-semibold
                           file:bg-primary-50 file:text-primary-700
                           hover:file:bg-primary-100"
              />
              {invErrors.length > 0 && (
                <Alert variant="error">
                  {invErrors.map((e, i) => <div key={i}>{e}</div>)}
                </Alert>
              )}
              {invFile && invFile.name.match(/\.(xlsx|xls)$/i) && (
                <Alert variant="info">Preview for .xlsx is not shown; the server will validate and parse.</Alert>
              )}
            </CardContent>
            <CardFooter className="flex justify-end">
              <Button onClick={uploadInventory} disabled={invUploading || !invFile}>
                {invUploading ? 'Uploading…' : 'Upload Inventory'}
              </Button>
            </CardFooter>

            {invRows.length > 0 && (
              <CardContent>
                <div className="mt-4 border-t pt-4">
                  <h4 className="text-md font-semibold text-gray-900 mb-2">Preview (first 20 rows)</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead>On Hand</TableHead>
                        <TableHead>Cost</TableHead>
                        <TableHead>Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invRows.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.Product}</TableCell>
                          <TableCell>{r['On Hand'] ?? r['Quantity on Hand'] ?? ''}</TableCell>
                          <TableCell>{r.Cost ?? ''}</TableCell>
                          <TableCell>{r.Price ?? ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            )}

            {invSummary && (
              <CardContent>
                <Alert variant="info">
                  <div className="space-y-1">
                    <div><span className="font-semibold">Imported products:</span> {invSummary.imported_products ?? 0}</div>
                    <div><span className="font-semibold">Inventory rows updated:</span> {invSummary.inventory_rows ?? 0}</div>
                    <div><span className="font-semibold">Price rows added:</span> {invSummary.price_rows ?? 0}</div>
                  </div>
                  {invSummary.rejected?.length > 0 && (
                    <div className="mt-2 text-sm text-gray-700">
                      Rejected {invSummary.rejected.length} rows. (Check logs for details.)
                    </div>
                  )}
                </Alert>
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </AppShell>
  )
}
