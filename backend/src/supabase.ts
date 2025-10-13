import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────
// Environment variables
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL as string
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables.')
}

// ─────────────────────────────────────────────────────────────
// Service client (server-side only)
// ─────────────────────────────────────────────────────────────
export const supabaseService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,          // no local storage
    autoRefreshToken: false,        // we’ll manage tokens manually
    detectSessionInUrl: false
  }
})