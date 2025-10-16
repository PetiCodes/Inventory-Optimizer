import { Router } from 'express'
import { supabaseService } from '../src/supabase.js'

const router = Router()

/* ---------- Date Utilities ---------- */
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
const monthStart = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-01`
const last12Start = () => monthStart(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)))
const todayISO = () => ymd(new Date())

const weights12 = Array.from({ length: 12 }, (_, i) => i + 1)
const wSum12 = weights12.reduce((a,b)=>a+b,0)

/* ---------- Helpers ---------- */
function keyMonth(dateIso: string) {
  const y = dateIso.slice(0,4)
  const m = dateIso.slice(5,7)
  return `${y}-${m}-01`
}

function buildCostTimeline(prices) {
  const map = new Map()
  for (const p of prices) {
    const pid = String(p.product_id)
    const arr = map.get(pid) ?? []
    arr.push({ d: String(p.effective_date), c: Number(p.unit_cost ?? 0) })
    map.set(pid, arr)
  }
  for (const [pid, arr] of map) arr.sort((a,b)=>a.d.localeCompare(b.d))
  return map
}
function costAtDate(timeline, saleDate) {
  if (!timeline || !timeline.length) return 0
  let lo=0, hi=timeline.length-1, ans=-1
  while (lo<=hi) {
    const mid=(lo+hi)>>1
    if (timeline[mid].d <= saleDate){ ans=mid; lo=mid+1 } else hi=mid-1
  }
  return ans>=0 ? timeline[ans].c : 0
}

router.get('/dashboard/overview', async (_req,res)=>{
  try {
    const start12 = last12Start()
    const endDate = todayISO()

    // ─────────────────────────────────────────────────────────
    // 1. Run all simple fetches in parallel
    // ─────────────────────────────────────────────────────────
    const [prodHead, custHead, salesQ, namesQ, invQ] = await Promise.all([
      supabaseService.from('products').select('id', { count: 'exact', head: true }),
      supabaseService.from('customers').select('id', { count: 'exact', head: true }),
      supabaseService.from('sales')
        .select('product_id,date,quantity,unit_price')
        .gte('date', start12)
        .lte('date', endDate),
      supabaseService.from('products').select('id,name'),
      supabaseService.from('inventory_current').select('product_id,on_hand'),
    ])

    if (prodHead.error) throw prodHead.error
    if (custHead.error) throw custHead.error
    if (salesQ.error) throw salesQ.error
    if (namesQ.error) throw namesQ.error
    if (invQ.error) throw invQ.error

    const productsCount = prodHead.count ?? 0
    const customersCount = custHead.count ?? 0
    const sales = salesQ.data ?? []
    const nameMap = new Map(namesQ.data.map(r => [String(r.id), r.name ?? '(unnamed)']))
    const onHandMap = new Map(invQ.data.map(r => [String(r.product_id), Number(r.on_hand ?? 0)]))

    // ─────────────────────────────────────────────────────────
    // 2. Load only relevant prices (reduce payload)
    // ─────────────────────────────────────────────────────────
    const productIds = Array.from(new Set(sales.map(s=>String(s.product_id))))
    let priceData = []
    if (productIds.length) {
      const priceQ = await supabaseService
        .from('product_prices')
        .select('product_id,effective_date,unit_cost')
        .in('product_id', productIds)
        .lte('effective_date', endDate)
      if (priceQ.error) throw priceQ.error
      priceData = priceQ.data ?? []
    }
    const costTimeline = buildCostTimeline(priceData)

    // ─────────────────────────────────────────────────────────
    // 3. Aggregate 12-month sales w/ historical cost
    // ─────────────────────────────────────────────────────────
    const monthIdx = new Map()
    const months: string[] = []
    const now = new Date()
    for (let i=11;i>=0;i--){
      const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-i,1))
      const key=monthStart(d)
      months.push(key)
    }
    months.forEach((m,i)=>monthIdx.set(m,i))

    const perProdMonthly = new Map()
    const lastSaleDate = new Map()
    const qtyMap = new Map()
    const revenueMap = new Map()
    const gpMap = new Map()

    for (const s of sales) {
      const pid=String(s.product_id)
      const q=Number(s.quantity??0)
      const up=Number(s.unit_price??0)
      const d=String(s.date)

      qtyMap.set(pid,(qtyMap.get(pid)??0)+q)
      revenueMap.set(pid,(revenueMap.get(pid)??0)+q*up)

      const uc = costAtDate(costTimeline.get(pid), d)
      gpMap.set(pid,(gpMap.get(pid)??0)+ (up-uc)*q)

      const mk = keyMonth(d)
      const idx=monthIdx.get(mk)
      if (idx!=null){
        const arr=perProdMonthly.get(pid)??Array(12).fill(0)
        arr[idx]+=q
        perProdMonthly.set(pid,arr)
      }
      const prev=lastSaleDate.get(pid)
      if (!prev || d>prev) lastSaleDate.set(pid,d)
    }

    const totalQty = Array.from(qtyMap.values()).reduce((a,b)=>a+b,0)
    const totalRevenue = Array.from(revenueMap.values()).reduce((a,b)=>a+b,0)

    // ─────────────────────────────────────────────────────────
    // 4. At-Risk of Stockout
    // ─────────────────────────────────────────────────────────
    const atRisk=[]
    for (const pid of new Set([...onHandMap.keys(),...perProdMonthly.keys()])){
      const arr=perProdMonthly.get(pid)??Array(12).fill(0)
      const weightedSum=arr.reduce((a,q,i)=>a+q*weights12[i],0)
      const wavg=weightedSum/wSum12
      const weightedMOQ=Math.ceil(Math.max(0,wavg))
      const onHand=onHandMap.get(pid)??0
      const gap=Math.max(0,weightedMOQ-onHand)
      if (gap>0){
        atRisk.push({
          product_id:pid,
          product_name:nameMap.get(pid)??'(unnamed)',
          on_hand:onHand,
          weighted_moq:weightedMOQ,
          gap,
          last_sale_date:lastSaleDate.get(pid)??null
        })
      }
    }
    atRisk.sort((a,b)=>b.gap-a.gap)
    const atRiskTop=atRisk.slice(0,20)

    // ─────────────────────────────────────────────────────────
    // 5. Top Products by GROSS PROFIT (accurate, last 12m)
    // ─────────────────────────────────────────────────────────
    const top=[]
    for (const pid of qtyMap.keys()){
      const q=qtyMap.get(pid)??0
      const r=revenueMap.get(pid)??0
      const gp=gpMap.get(pid)??0
      top.push({
        product_id:pid,
        product_name:nameMap.get(pid)??'(unnamed)',
        qty_12m:q,
        revenue_12m:r,
        gross_profit_12m:gp
      })
    }
    top.sort((a,b)=>b.gross_profit_12m-a.gross_profit_12m)
    const topProducts=top.slice(0,20)

    // ─────────────────────────────────────────────────────────
    // 6. Respond
    // ─────────────────────────────────────────────────────────
    return res.json({
      totals:{
        products:productsCount,
        customers:customersCount,
        sales_12m_qty:totalQty,
        sales_12m_revenue:totalRevenue
      },
      atRisk:atRiskTop,
      topProducts
    })
  } catch(e){
    console.error('GET /dashboard/overview error:',e)
    return res.status(500).json({error:e.message||'Server error'})
  }
})

export default router
