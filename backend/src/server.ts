import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import 'dotenv/config'

import meRouter from '../routes/me.js'
import uploadRouter from '../routes/upload.js'
import analysisRouter from '../routes/analysis.js'
import productsRouter from '../routes/products.js'
import dashboardRouter from '../routes/dashboard.js'
import customersRouter from '../routes/customers.js'
import inventoryRouter from '../routes/inventory.js'
import adminRouter from '../routes/admin.js'

const app = express()

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow images/fonts if any
}))

// Build allowed origins from env + sensible defaults
const allowList = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // add your exact Vercel URL(s) below:
  'https://inventory-optimizer-five.vercel.app',
  'https://inventory-optimizer-21kc.onrender.com',
])

// Also allow any *.vercel.app if you spin previews:
const vercelRegex = /\.vercel\.app$/

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true) // allow curl/postman
    if (allowList.has(origin) || vercelRegex.test(origin)) return cb(null, true)
    return cb(new Error(`CORS blocked for origin: ${origin}`))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
}
app.use(cors(corsOptions))

// Important: respond to preflight quickly
app.options('*', cors(corsOptions))

app.use(express.json({ limit: '2mb' }))
app.use(morgan('dev'))

app.get('/', (_req, res) => res.type('text/plain').send('Backend is up.'))
app.get('/health', (_req, res) => res.json({ ok: true }))

app.use('/api', meRouter)
app.use('/api', uploadRouter)       // POST /api/upload
app.use('/api', analysisRouter)
app.use('/api', productsRouter)
app.use('/api', dashboardRouter)
app.use('/api', customersRouter)
app.use('/api', inventoryRouter)    // POST /api/inventory/upload
app.use('/api', adminRouter)

// fallback 404 (optional)
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

const port = Number(process.env.PORT || 4000)
app.listen(port, () => console.log(`API listening on http://localhost:${port}`))
