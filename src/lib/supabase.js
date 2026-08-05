import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// During local scaffolding before a real Supabase project is wired up,
// these env vars won't be set — api.js falls back to mock data in that case.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export const isConfigured = Boolean(supabase);
