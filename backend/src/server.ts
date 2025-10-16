// backend/src/server.ts
import express, { Request, Response } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'

// Routers
import meRouter from '../routes/me.js'
import uploadRouter from '../routes/upload.js'
import analysisRouter from '../routes/analysis.js'
import productsRouter from '../routes/products.js'
import dashboardRouter from '../routes/dashboard.js'
import customersRouter from '../routes/customers.js'
import inventoryRouter from '../routes/inventory.js'

const app = express()

// ── Security & basics
app.use(helmet())
app.use(express.json({ limit: '10mb' }))
app.use(morgan('dev'))

// ── CORS: allow your local + vercel domains (comma separated in env)
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  })
)

// ── Very lightweight health endpoints for Render
app.get('/', (_req: Request, res: Response) => res.type('text/plain').send('Backend is up.'))
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }))

// ── API routes
app.use('/api', meRouter)
app.use('/api', uploadRouter)
app.use('/api', analysisRouter)
app.use('/api', productsRouter)
app.use('/api', dashboardRouter)
app.use('/api', customersRouter)
app.use('/api', inventoryRouter)

// ── 404 + error fallbacks (won’t affect health)
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }))
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Server error' })
})

// ── IMPORTANT: Bind on Render’s PORT and 0.0.0.0
const port = Number(process.env.PORT || 4000)
app.listen(port, '0.0.0.0', () => {
  console.log(`API listening on http://0.0.0.0:${port}`)
})
