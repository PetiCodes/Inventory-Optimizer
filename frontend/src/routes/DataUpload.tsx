import React, { useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader, CardFooter } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import Spinner from '../components/ui/Spinner'
import { useToast } from '../components/ToastProvider'
import { supabase } from '../lib/supabaseClient'

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

  // Upload state
  const [salesFile, setSalesFile] = useState<File | null>(null)
  const [salesRows, setSalesRows] = useState<SalesPreviewRow[]>([])
  const [salesErrors, setSalesErrors] = useState<string[]>([])
  const [salesUploading, setSalesUploading] = useState(false)
  const [salesSummary, setSalesSummary] = useState<any | null>(null)

  const [invFile, setInvFile] = useState<File | null>(null)
  const [invUploading, setInvUploading] = useState(false)
  const [invErrors, setInvErrors] = useState<string[]>([])
  const [invSummary, setInvSummary] = useState<any | null>(null)

  // GP Refresh
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [refreshErr, setRefreshErr] = useState<string | null>(null)

  // Danger wipe
  const [wiping, setWiping] = useState(false)

  function isCSV(name: string) { return /\.csv$/i.test(name) }
  function isExcel(name: string) { return /\.(xlsx|xls)$/i.test(name) }

  /* ---------------- Sales: onChange ---------------- */
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
            setSalesErrors(['Invalid headers. Expected: Date, Customer Name, Product, Quantity, Price'])
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
        } catch {
          setSalesErrors(['Failed to read CSV preview'])
        }
      }
      reader.readAsText(f)
    }
  }

  /* ---------------- Inventory: onChange ---------------- */
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

  /* ---------------- Upload Sales ---------------- */
  async function uploadSales() {
    if (!salesFile) {
      addToast('Please choose a sales file', 'warning')
      return
    }
    setSalesUploading(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const fd = new FormData()
      fd.append('file', salesFile!)
      const res = await fetch(`${API}/api/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      })
      const data = await res.json()
      setSalesSummary(data)
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      addToast(`Imported ${data.inserted ?? 0} sales rows`, 'success')
    } catch (e: any) {
      addToast(e.message || 'Sales upload failed', 'error')
    } finally {
      setSalesUploading(false)
    }
  }

  /* ---------------- Upload Inventory ---------------- */
  async function uploadInventory() {
    if (!invFile) {
      addToast('Please choose an inventory file', 'warning')
      return
    }
    setInvUploading(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const fd = new FormData()
      fd.append('file', invFile!)
      const res = await fetch(`${API}/api/inventory/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      })
      const data = await res.json()
      setInvSummary(data)
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      addToast(`Inventory updated (${data.inventory_rows ?? 0} rows)`, 'success')
    } catch (e: any) {
      addToast(e.message || 'Inventory upload failed', 'error')
    } finally {
      setInvUploading(false)
    }
  }

  /* ---------------- Refresh GP Cache ---------------- */
  async function refreshGrossProfit() {
    setRefreshErr(null)
    setRefreshMsg(null)
    setRefreshBusy(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined
      let res = await fetch(`${API}/api/admin/refresh-gross-profit`, { method: 'POST', headers })
      if (res.status === 404) res = await fetch(`${API}/api/refresh-gross-profit`, { method: 'POST', headers })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
      const msg = `Recalculated. Rows updated: ${json.rows ?? '—'}.`
      setRefreshMsg(msg)
      addToast(msg, 'success')
    } catch (e: any) {
      setRefreshErr(e.message || 'Refresh failed')
      addToast(e.message || 'Refresh failed', 'error')
    } finally {
      setRefreshBusy(false)
    }
  }

  /* ---------------- Delete ALL Data ---------------- */
  async function wipeAllData() {
    const c1 = window.confirm('This will permanently delete ALL sales, inventory, prices, customers, and products. Continue?')
    if (!c1) return
    const c2 = window.prompt('Type DELETE to confirm:')
    if (c2 !== 'DELETE') return

    setWiping(true)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      const res = await fetch(`${API}/api/admin/wipe-data`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to delete')
      addToast('All data deleted successfully.', 'success')
    } catch (e: any) {
      addToast(e.message || 'Failed to delete data', 'error')
    } finally {
      setWiping(false)
    }
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Data Upload</h1>
            <p className="text-gray-600">
              Upload Sales and Inventory files. Then recalculate or delete everything.
            </p>
          </div>
          <Button onClick={refreshGrossProfit} disabled={refreshBusy}>
            {refreshBusy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="sm" /> Recalculating…
              </span>
            ) : (
              'Recalculate Gross Profit (12M)'
            )}
          </Button>
        </div>

        {refreshErr && <Alert variant="error">{refreshErr}</Alert>}
        {refreshMsg && <Alert variant="success">{refreshMsg}</Alert>}

        {/* Sales and Inventory Cards (unchanged) */}
        {/* ... your existing upload cards here ... */}

        {/* Danger Zone */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-red-700">Danger Zone</h3>
            <p className="text-sm text-red-600">
              This action will permanently delete ALL records in your database.
            </p>
          </CardHeader>
          <CardFooter className="flex justify-end">
            <Button variant="danger" onClick={wipeAllData} disabled={wiping}>
              {wiping ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="sm" /> Deleting…
                </span>
              ) : (
                'Delete ALL Data'
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </AppShell>
  )
}
