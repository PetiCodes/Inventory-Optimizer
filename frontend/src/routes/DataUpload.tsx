import React, { useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardContent, CardHeader, CardFooter } from '../components/ui/Card'
import Table, { TableHeader, TableRow, TableHead, TableBody, TableCell } from '../components/ui/Table'
import Button from '../components/ui/Button'
import Alert from '../components/ui/Alert'
import { useToast } from '../components/ToastProvider'
import { supabase } from '../lib/supabaseClient'

type PreviewRow = {
  Date: string
  'Customer Name': string
  Product: string
  Quantity: string | number
  Price?: string | number
}

const REQUIRED_HEADERS = ['Date', 'Customer Name', 'Product', 'Quantity'] as const

export default function DataUpload() {
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [summary, setSummary] = useState<any | null>(null)
  const [uploading, setUploading] = useState(false)
  const { addToast } = useToast()

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setFile(f)
    setRows([])
    setErrors([])
    setSummary(null)
    if (!f) return

    const name = f.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
      setErrors(['Unsupported file type. Use .xlsx, .xls, or .csv'])
      return
    }

    if (name.endsWith('.csv')) {
      const reader = new FileReader()
      reader.onload = () => {
        try {
          const text = String(reader.result || '')
          const lines = text.split(/\r?\n/).filter(Boolean)
          if (!lines.length) return
          const headers = lines[0].split(',').map(h => h.trim())
          const valid =
            REQUIRED_HEADERS.length <= headers.length &&
            REQUIRED_HEADERS.every(h => headers.includes(h))
          if (!valid) {
            setErrors(['Invalid headers. Expected: Date, Customer Name, Product, Quantity (Price optional)'])
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
                Price: cells[4]
              } as PreviewRow
            })
          setRows(parsed)
        } catch {
          setErrors(['Failed to read CSV preview'])
        }
      }
      reader.readAsText(f)
    } else {
      setRows([])
    }
  }

  async function onUpload() {
    if (!file) {
      addToast('Please choose a file', 'warning')
      return
    }
    setUploading(true)
    setSummary(null)
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token
      if (!token) throw new Error('Not authenticated')

      const fd = new FormData()
      fd.append('file', file)

      const res = await fetch((import.meta as any).env.VITE_API_BASE + '/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      })
      const data = await res.json()
      setSummary(data)
      if (!res.ok) {
        addToast(data?.error || 'Upload failed', 'error')
      } else {
        addToast(`Imported ${data.inserted} rows. Rejected ${data.rejectedCount}.`, 'success')
      }
    } catch (e: any) {
      addToast(e.message || 'Upload failed', 'error')
    } finally {
      setUploading(false)
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Data Upload</h1>
          <p className="text-gray-600">
            Upload Excel/CSV with headers: <code>Date, Customer Name, Product, Quantity</code>{' '}
            (<em>Price optional</em>)
          </p>
        </div>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-gray-900">Upload File</h3>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onFileChange}
              className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
            />
            {errors.length > 0 && (
              <Alert variant="error">
                {errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Alert>
            )}
            {file && file.name.match(/\.(xlsx|xls)$/i) && (
              <Alert variant="info">Preview for .xlsx is not shown here; server will validate and parse.</Alert>
            )}
          </CardContent>
          <CardFooter className="flex justify-end">
            <Button onClick={onUpload} disabled={uploading || !file}>
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </CardFooter>
        </Card>

        {rows.length > 0 && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-gray-900">Preview (first 20 rows)</h3>
            </CardHeader>
            <CardContent>
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
                  {rows.map((r, i) => (
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
            </CardContent>
          </Card>
        )}

        {summary?.reasonCounts && (
          <Alert variant="warning">
            <div className="font-semibold mb-2">Rejected rows breakdown</div>
            <ul className="list-disc ml-6 space-y-1">
              {Object.entries(summary.reasonCounts).map(([k, v]) => (
                <li key={k}>
                  {k}: {v as number}
                </li>
              ))}
            </ul>
            {summary.sampleRejected?.length > 0 && (
              <div className="mt-2 text-sm text-gray-700">
                Showing first {summary.sampleRejected.length} rejected rows with reasons.
              </div>
            )}
          </Alert>
        )}
      </div>
    </AppShell>
  )
}
