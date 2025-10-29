import React, { useState } from 'react'
import AppShell from '../components/layout/AppShell'
import Card, { CardHeader, CardContent } from '../components/ui/Card'
import Button from '../components/ui/Button'
import Spinner from '../components/ui/Spinner'
import Alert from '../components/ui/Alert'
import { supabase } from '../lib/supabaseClient'
import * as XLSX from 'xlsx'

type ExportType = 'all-products' | 'best-products' | 'worst-products' | 'products-at-risk'

type ProductRow = {
  id: string
  name: string
  qty_12m?: number
  revenue_12m?: number
  gross_profit_12m?: number
  on_hand: number
  weighted_moq?: number
  gap?: number
}

export default function Export() {
  const [exportType, setExportType] = useState<ExportType | ''>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchExportData(type: ExportType): Promise<ProductRow[]> {
    const token = (await supabase.auth.getSession()).data.session?.access_token
    if (!token) throw new Error('Not authenticated')

    const endpoint = `/api/export/${type}`
    const res = await fetch(`${(import.meta as any).env.VITE_API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` }
    })

    if (!res.ok) {
      const json = await res.json()
      throw new Error(json?.error || `HTTP ${res.status}`)
    }

    const json = await res.json()
    return json.items ?? []
  }

  function exportToExcel(data: ProductRow[], type: ExportType) {
    let worksheetData: any[] = []
    let filename = ''

    if (type === 'all-products' || type === 'best-products' || type === 'worst-products') {
      filename = type === 'all-products' 
        ? 'All_Products' 
        : type === 'best-products' 
        ? 'Best_Products' 
        : 'Worst_Products'
      
      worksheetData = data.map((p, idx) => ({
        '#': idx + 1,
        'Product Name': p.name,
        'Quantity (12m)': p.qty_12m ?? 0,
        'Revenue (12m)': p.revenue_12m ?? 0,
        'Gross Profit (12m)': p.gross_profit_12m ?? 0,
        'On Hand': p.on_hand ?? 0,
      }))
    } else if (type === 'products-at-risk') {
      filename = 'Products_At_Risk_Stockout'
      worksheetData = data.map((p, idx) => ({
        '#': idx + 1,
        'Product Name': p.name,
        'On Hand': p.on_hand ?? 0,
        'Weighted MOQ': p.weighted_moq ?? 0,
        'Gap': p.gap ?? 0,
      }))
    }

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(worksheetData)

    // Auto-size columns
    const maxWidth = 30
    const colWidths = Object.keys(worksheetData[0] || {}).map(key => {
      const maxLength = Math.max(
        key.length,
        ...worksheetData.map(row => String(row[key] || '').length)
      )
      return { wch: Math.min(maxLength + 2, maxWidth) }
    })
    ws['!cols'] = colWidths

    XLSX.utils.book_append_sheet(wb, ws, 'Data')

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '_')
    const finalFilename = `${filename}_${timestamp}.xlsx`

    // Download
    XLSX.writeFile(wb, finalFilename)
  }

  async function handleExport() {
    if (!exportType) {
      setError('Please select an export type')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const data = await fetchExportData(exportType)
      if (data.length === 0) {
        setError('No data available to export')
        return
      }
      exportToExcel(data, exportType)
    } catch (e: any) {
      setError(e.message || 'Failed to export data')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Export Data</h1>
          <p className="text-gray-600">Export product data to Excel format</p>
        </div>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-gray-900">Select Export Type</h3>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert variant="error">{error}</Alert>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div
                className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                  exportType === 'all-products'
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => setExportType('all-products')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    checked={exportType === 'all-products'}
                    onChange={() => setExportType('all-products')}
                    className="w-4 h-4 text-primary-600"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">All Products</h4>
                    <p className="text-sm text-gray-600">Export all products with full details</p>
                  </div>
                </div>
              </div>

              <div
                className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                  exportType === 'best-products'
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => setExportType('best-products')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    checked={exportType === 'best-products'}
                    onChange={() => setExportType('best-products')}
                    className="w-4 h-4 text-primary-600"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">Best Products</h4>
                    <p className="text-sm text-gray-600">Products with highest gross profit (12m)</p>
                  </div>
                </div>
              </div>

              <div
                className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                  exportType === 'worst-products'
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => setExportType('worst-products')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    checked={exportType === 'worst-products'}
                    onChange={() => setExportType('worst-products')}
                    className="w-4 h-4 text-primary-600"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">Worst Products</h4>
                    <p className="text-sm text-gray-600">Products with lowest gross profit (12m)</p>
                  </div>
                </div>
              </div>

              <div
                className={`p-4 border-2 rounded-lg cursor-pointer transition-colors ${
                  exportType === 'products-at-risk'
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => setExportType('products-at-risk')}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="radio"
                    checked={exportType === 'products-at-risk'}
                    onChange={() => setExportType('products-at-risk')}
                    className="w-4 h-4 text-primary-600"
                  />
                  <div>
                    <h4 className="font-semibold text-gray-900">Products at Risk of Stockout</h4>
                    <p className="text-sm text-gray-600">Products with inventory gaps</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t">
              <Button
                onClick={handleExport}
                disabled={!exportType || loading}
                className="w-full md:w-auto"
              >
                {loading ? (
                  <>
                    <Spinner size="sm" className="mr-2" />
                    Exporting...
                  </>
                ) : (
                  'Export to Excel'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}

