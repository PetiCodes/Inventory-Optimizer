// backend/src/server.ts
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'

import meRouter from '../routes/me'
import uploadRouter from '../routes/upload'
import analysisRouter from '../routes/analysis'
import productsRouter from '../routes/products'
import dashboardRouter from '../routes/dashboard'
import customersRouter from '../routes/customers'
import inventoryRouter from '../routes/inventory'

const app = express()

// --- CORS: allow your frontend origin(s) + Authorization header ---
function parseOrigins(src?: string): string[] | boolean {
  if (!src || src.trim() === '') return ['http://localhost:5173']
  const arr = src.split(',').map(s => s.trim()).filter(Boolean)
  return arr.length ? arr : ['http://localhost:5173']
}

const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN as string | undefined)

app.use(helmet())
// Note: helmet sets some defaults that are fine with CORS; if you ever serve iframes/images from other origins,
// consider adjusting specific Helmet policies.

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600, // cache preflight for 10 minutes
  })
)
// Ensure OPTIONS preflights are handled for every route
app.options('*', cors())

// Body parser (JSON routes only; multipart handled by multer inside routes)
app.use(express.json({ limit: '10mb' }))
app.use(morgan('dev'))

// --- Health endpoints ---
app.get('/', (_req, res) => res.type('text/plain').send('Backend is up.'))
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --- API routes ---
app.use('/api', meRouter)
app.use('/api', uploadRouter)
app.use('/api', analysisRouter)
app.use('/api', productsRouter)
app.use('/api', dashboardRouter)
app.use('/api', customersRouter)
app.use('/api', inventoryRouter)

// 404 handler (JSON)
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Central error handler (prevents hard crashes → “Failed to fetch” on client)
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  const status = typeof err?.status === 'number' ? err.status : 500
  res.status(status).json({ error: err?.message || 'Server error' })
})

const port = Number(process.env.PORT || 4000)
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
  console.log('Allowed CORS origins:', allowedOrigins)
})

// (optional) export for testing
export default app
