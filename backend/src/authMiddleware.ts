import type { Request, Response, NextFunction } from 'express'
import { supabaseService } from './supabase.js'

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization || ''
    const [, token] = authHeader.split(' ')

    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' })
    }

    // Verify the JWT with Supabase (using Service Role)
    const { data, error } = await supabaseService.auth.getUser(token)

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    // Optional extra gate: block unverified emails
    // if (!data.user.email_confirmed_at) {
    //   return res.status(403).json({ error: 'Email not confirmed' })
    // }

    // Attach user info to request object for downstream use
    ;(req as any).user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role,
      app_metadata: data.user.app_metadata,
      user_metadata: data.user.user_metadata
    }

    // ✅ Auth successful
    next()
  } catch (err) {
    console.error('Auth middleware error:', err)
    return res.status(401).json({ error: 'Unauthorized' })
  }
}
