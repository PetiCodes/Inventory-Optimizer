// backend/src/routes/me.ts
import { Router } from 'express'
import { requireAuth } from '../src/authMiddleware' // we'll fix this import below if needed

const router = Router()

router.get('/me', requireAuth, async (req, res) => {
  const user = (req as any).user
  res.json({ id: user.id, email: user.email, aud: user.aud })
})

export default router
