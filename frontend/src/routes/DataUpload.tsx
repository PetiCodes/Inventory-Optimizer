import React, { useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader, CardFooter } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import { useToast } from '../components/ToastProvider'
import { supabase } from '../lib/supabaseClient'

/** ---------- Sales (CSV preview) ---------- */
type SalesPreviewRow = {
  Date: string
  'Customer Name': string
  Product: string
  Quantity: string | number
  Price?: string | number
}
const SALES_REQUIRED_HEADERS = ['Date', 'Customer Name', 'Product', 'Quantity', 'Price'] as const

export default function DataUpload() {
  const { addToast } = useToast()
  const API = (import.meta as any).env.VITE_API_BASE as string

  // Sales upload state
  const [salesFile, setSalesFile] = useState<File | null>(null)
  const [salesRows, setSalesRows] = useState<SalesPreviewRow[]>([])
  const [salesErrors, setSalesErrors] = useState<string[]>([])
  const [salesUploading, setSalesUploading] = useState(false)
  const [salesSummary, setSalesSummary] = useState<any | null>(null)

  // Inventory upload state
  const [invFile, setInvFile] = useState<File | null>(null)
  const [invUploading, setInvUploading] = useState(false)
  const [invErrors, setInvErrors] = useState<string[]>([])
  const [invSummary, setInvSummary] = useState<any | null>(null)

  // Recalc GP cache
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [refreshErr, setRefreshErr] = useState<string | null>(null)

  // Delete data state
  const [wiping, setWiping] = useState(false)
  const [deletingSales, setDeletingSales] = useState(false)
  const [deletingInventory, setDeletingInventory] = useState(false)

  // At-risk refresh state
  const [atRiskBusy, setAtRiskBusy] = useState(false)
  const [atRiskMsg, setAtRiskMsg] = useState<string | null>(null)
  const [atRiskErr, setAtRiskErr] = useState<string | null>(null)

  /** ----------------- Helpers ----------------- */
  function isCSV(name: string) { return /\.csv$/i.test(name) }
  function isExcel(name: string) { return /\.(xlsx|xls)$/i.test(name) }

  /** ----------------- Sales: onFileChange (with CSV preview) ----------------- */
  function onSalesFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setSalesFile(f)
    setSalesRows([])
    setSalesErrors([])
    setSalesSummary(null)
    if (!f) return

    const name = f.name.toLowerCase()
    if (!isCSV(name) && !isExcel(name)) {
      setSalesErrors(['Unsupported file type. Use .xlsx, .xls, or .csv'])
      return
    }

    if (isCSV(name)) {
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = String(reader.result || '')
          const lines = text.split(/\r?\n/).filter(Boolean)
          if (!lines.length) return

          const headers = lines[0].split(',').map(h => h.trim())
          const valid =
            SALES_REQUIRED_HEADERS.length === headers.length &&
            SALES_REQUIRED_HEADERS.every((h, i) => headers[i] === h)

          if (!valid) {
            setSalesErrors([
              'Invalid headers. Expected: Date, Customer Name, Product, Quantity, Price',
            ])
            return
          }

          const parsed = lines
            .slice(1)
            .slice(0, 20)
            .map(line => {
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
        } catch {
          setSalesErrors(['Failed to read CSV preview'])
        }
      }
      reader.readAsText(f)
    } else {
      // xlsx/xls — let backend validate & parse
      setSalesRows([])
    }
  }

  /** ----------------- Inventory: onFileChange ----------------- */
  function onInventoryFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setInvFile(f)
    setInvErrors([])
    setInvSummary(null)
    if (!f) return

    const name = f.name.toLowerCase()
    if (!isCSV(name) && !isExcel(name)) {
      setInvErrors(['Unsupported file type. Use .xlsx, .xls, or .csv'])
      return
    }
  }

  /** ----------------- Upload Sales ----------------- */
  async function uploadSales() {
    if (!salesFile) {
      addToast('Please choose a sales file', 'warning')
      return
    }
    setSalesUploading(true)
    setSalesSummary(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const fd = new FormData()
      fd.append('file', salesFile)

      const res = await fetch(`${API}/api/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })

      const data = await res.json()
      setSalesSummary(data)

      if (!res.ok) {
        addToast(data?.error || 'Sales upload failed', 'error')
      } else {
        const inserted = data.inserted ?? 0
        const rejected = data.rejectedCount ?? 0
        const totalProcessed = data.totalRowsProcessed ?? 0
        const message = rejected > 0 
          ? `Imported ${inserted} of ${totalProcessed} rows. ${rejected} rejected (see details below).`
          : `Successfully imported ${inserted} sales rows.`
        addToast(message, rejected > 0 ? 'warning' : 'success')
      }
    } catch (e: any) {
      addToast(e.message || 'Sales upload failed', 'error')
    } finally {
      setSalesUploading(false)
    }
  }

  /** ----------------- Upload Inventory ----------------- */
  async function uploadInventory() {
    if (!invFile) {
      addToast('Please choose an inventory file', 'warning')
      return
    }
    setInvUploading(true)
    setInvSummary(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const fd = new FormData()
      fd.append('file', invFile)

      const res = await fetch(`${API}/api/inventory/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })

      const data = await res.json()
      setInvSummary(data)

      if (!res.ok) {
        addToast(data?.error || 'Inventory upload failed', 'error')
      } else {
        const upd = data.inventory_rows ?? 0
        const priceRows = data.price_rows ?? 0
        addToast(`Inventory updated: ${upd}. Prices added: ${priceRows}.`, 'success')
      }
    } catch (e: any) {
      addToast(e.message || 'Inventory upload failed', 'error')
    } finally {
      setInvUploading(false)
    }
  }

  /** ----------------- Recalculate 12M Gross Profit cache ----------------- */
  async function refreshGrossProfit() {
    setRefreshErr(null)
    setRefreshMsg(null)
    setRefreshBusy(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined

      // Try the preferred path first
      let res = await fetch(`${API}/api/admin/refresh-gross-profit`, { method: 'POST', headers })
      if (res.status === 404) {
        // Fallback to alias
        res = await fetch(`${API}/api/refresh-gross-profit`, { method: 'POST', headers })
      }
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

      const msg = `Recalculated. Rows updated: ${json.rows ?? '—'}.`
      setRefreshMsg(msg)
      addToast(msg, 'success')
    } catch (e: any) {
      const m = e.message || 'Refresh failed'
      setRefreshErr(m)
      addToast(m, 'error')
    } finally {
      setRefreshBusy(false)
    }
  }

  /** ----------------- Recalculate At-Risk Products Cache ----------------- */
  async function refreshAtRisk() {
    setAtRiskErr(null)
    setAtRiskMsg(null)
    setAtRiskBusy(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined

      let res = await fetch(`${API}/api/admin/refresh-at-risk`, { method: 'POST', headers })
      if (res.status === 404) {
        res = await fetch(`${API}/api/refresh-at-risk`, { method: 'POST', headers })
      }
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)

      const msg = `Cache refreshed. ${json.rows ?? 0} products processed.`
      setAtRiskMsg(msg)
      addToast(msg, 'success')
    } catch (e: any) {
      const m = e.message || 'Refresh failed'
      setAtRiskErr(m)
      addToast(m, 'error')
    } finally {
      setAtRiskBusy(false)
    }
  }

  /** ----------------- Delete ALL Data (Danger) ----------------- */
  async function wipeAllData() {
    const c1 = window.confirm('This will permanently delete ALL sales, inventory, prices, customers, and products. Continue?')
    if (!c1) return
    const c2 = window.prompt('Type DELETE to confirm:')
    if (c2 !== 'DELETE') return

    try {
      setWiping(true)
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const res = await fetch(`${API}/api/admin/wipe-data`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to delete')
      addToast('All data deleted successfully.', 'success')

      // Reset local UI state
      setSalesFile(null)
      setSalesRows([])
      setSalesErrors([])
      setSalesSummary(null)
      setInvFile(null)
      setInvErrors([])
      setInvSummary(null)
      setRefreshMsg(null)
      setRefreshErr(null)
    } catch (e: any) {
      addToast(e.message || 'Failed to delete data', 'error')
    } finally {
      setWiping(false)
    }
  }

  /** ----------------- Delete Sales Data Only ----------------- */
  async function deleteSalesData() {
    const c1 = window.confirm('This will permanently delete ALL sales data and customers. Products will be kept. Continue?')
    if (!c1) return

    try {
      setDeletingSales(true)
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const res = await fetch(`${API}/api/admin/delete-sales-data`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to delete')
      
      const salesCount = data.deleted?.sales_rows ?? 0
      const custCount = data.deleted?.customers_rows ?? 0
      addToast(`Sales data deleted. ${salesCount} sales and ${custCount} customers removed. Products kept.`, 'success')

      // Reset sales-related UI state
      setSalesFile(null)
      setSalesRows([])
      setSalesErrors([])
      setSalesSummary(null)
    } catch (e: any) {
      addToast(e.message || 'Failed to delete sales data', 'error')
    } finally {
      setDeletingSales(false)
    }
  }

  /** ----------------- Delete Inventory Data Only ----------------- */
  async function deleteInventoryData() {
    const c1 = window.confirm('This will permanently delete ALL inventory, pricing data, and products. Continue?')
    if (!c1) return

    try {
      setDeletingInventory(true)
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const res = await fetch(`${API}/api/admin/delete-inventory-data`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to delete')
      
      const invCount = data.deleted?.inventory_rows ?? 0
      const priceCount = data.deleted?.price_rows ?? 0
      const prodCount = data.deleted?.products_rows ?? 0
      addToast(`Inventory data deleted. ${invCount} inventory, ${priceCount} price records, ${prodCount} products removed.`, 'success')

      // Reset inventory-related UI state
      setInvFile(null)
      setInvErrors([])
      setInvSummary(null)
    } catch (e: any) {
      addToast(e.message || 'Failed to delete inventory data', 'error')
    } finally {
      setDeletingInventory(false)
    }
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Data Upload</h1>
            <p className="text-gray-600">
              Upload Sales and Inventory files. Then recalculate the 12-month gross profit cache.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Recalculate button (unchanged) */}
            <Button onClick={refreshGrossProfit} disabled={refreshBusy}>
              {refreshBusy ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Recalculating…
                </span>
              ) : (
                'Recalculate Gross Profit (12M)'
              )}
            </Button>

            {/* At-Risk cache refresh button */}
            <Button onClick={refreshAtRisk} disabled={atRiskBusy}>
              {atRiskBusy ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Refreshing…
                </span>
              ) : (
                'Refresh At-Risk Cache'
              )}
            </Button>

            {/* Delete button: same visual style as recalc, but danger color */}
            <Button
              onClick={wipeAllData}
              disabled={wiping}
              className="!bg-red-600 !text-white hover:!bg-red-700 focus-visible:!ring-2 focus-visible:!ring-red-500"
            >
              {wiping ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Deleting…
                </span>
              ) : (
                'Delete ALL Data'
              )}
            </Button>
          </div>
        </div>

        {refreshErr && <Alert variant="error">{refreshErr}</Alert>}
        {refreshMsg && <Alert variant="success">{refreshMsg}</Alert>}
        {atRiskErr && <Alert variant="error">{atRiskErr}</Alert>}
        {atRiskMsg && <Alert variant="success">{atRiskMsg}</Alert>}

        {/* ----------------- Sales Upload ----------------- */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-gray-900">Sales Upload</h3>
            <p className="text-sm text-gray-600">
              Expected headers:&nbsp;
              <code>Date, Customer Name, Product, Quantity, Price</code>
              <br />
              <span className="text-xs">Note: All rows must include Date and Customer Name (no auto-fill)</span>
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
            {salesFile && isExcel(salesFile.name) && (
              <Alert variant="info">Preview for .xlsx is not shown here; server will validate and parse.</Alert>
            )}

            {salesRows.length > 0 && (
              <div className="mt-4">
                <h4 className="font-medium text-gray-900 mb-2">Preview (first 20 rows)</h4>
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
                        <TableCell>{r.Price ?? ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button
              onClick={deleteSalesData}
              disabled={deletingSales}
              className="!bg-red-600 !text-white hover:!bg-red-700 focus-visible:!ring-2 focus-visible:!ring-red-500"
            >
              {deletingSales ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Deleting…
                </span>
              ) : (
                'Delete Sales Data'
              )}
            </Button>
            <Button onClick={uploadSales} disabled={salesUploading || !salesFile}>
              {salesUploading ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Uploading…
                </span>
              ) : (
                'Upload Sales'
              )}
            </Button>
          </CardFooter>

          {salesSummary?.reasonCounts && Object.keys(salesSummary.reasonCounts).length > 0 && (
            <div className="px-6 pb-6">
              <Alert variant="warning">
                <div className="font-semibold mb-3">Rejected rows breakdown</div>
                <div className="text-sm mb-3">
                  <strong>Total rejected: {salesSummary.rejectedCount || 0}</strong>
                </div>
                <div className="font-semibold mb-2">By reason:</div>
                <ul className="list-disc ml-6 space-y-1 mb-4">
                  {Object.entries(salesSummary.reasonCounts).map(([k, v]) => (
                    <li key={k}>{k}: {v as number}</li>
                  ))}
                </ul>
                {salesSummary.sampleRejected && salesSummary.sampleRejected.length > 0 && (
                  <div className="mt-3">
                    <div className="font-semibold mb-2">Sample rejected rows:</div>
                    <div className="max-h-40 overflow-y-auto text-xs">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left p-1">Row</th>
                            <th className="text-left p-1">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {salesSummary.sampleRejected.slice(0, 20).map((item: any, idx: number) => (
                            <tr key={idx} className="border-b">
                              <td className="p-1">{item.row}</td>
                              <td className="p-1">{item.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {salesSummary.sampleRejected.length > 20 && (
                      <div className="mt-2 text-xs text-gray-600">
                        Showing first 20 of {salesSummary.sampleRejected.length} rejected rows.
                      </div>
                    )}
                  </div>
                )}
              </Alert>
            </div>
          )}
        </Card>

        {/* ----------------- Inventory Upload ----------------- */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-gray-900">Inventory Upload</h3>
            <p className="text-sm text-gray-600">
              Sheet should include columns like:&nbsp;
              <code>Name, Sales Price (Current), Cost, Quantity On Hand</code>
              . Product name matching is handled server-side (ignores leading [####] codes).
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onInventoryFileChange}
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
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button
              onClick={deleteInventoryData}
              disabled={deletingInventory}
              className="!bg-red-600 !text-white hover:!bg-red-700 focus-visible:!ring-2 focus-visible:!ring-red-500"
            >
              {deletingInventory ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Deleting…
                </span>
              ) : (
                'Delete Inventory Data'
              )}
            </Button>
            <Button onClick={uploadInventory} disabled={invUploading || !invFile}>
              {invUploading ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Uploading…
                </span>
              ) : (
                'Upload Inventory'
              )}
            </Button>
          </CardFooter>

          {invSummary && (
            <div className="px-6 pb-6">
              <Alert variant="info">
                <div>Imported products: {invSummary.imported_products ?? 0}</div>
                <div>Inventory rows updated: {invSummary.inventory_rows ?? 0}</div>
                <div>Price rows added: {invSummary.price_rows ?? 0}</div>
                {invSummary.rejected && (
                  <div className="mt-2 text-sm text-gray-700">
                    Rejected {invSummary.rejected} rows. (Check server logs for details.)
                  </div>
                )}
              </Alert>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  )
}
