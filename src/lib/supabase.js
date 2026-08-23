import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && key);
export const supabase = supabaseConfigured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

function redirectUrl() {
  return window.location.href;
}

export async function signInStaffWithGoogle() {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectUrl() },
  });
  if (error) throw error;
  return data;
}

export async function getSupabaseUser() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error && error.name !== 'AuthSessionMissingError') throw error;
  return data.user || null;
}

export function watchSupabaseUser(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session?.user || null));
  return () => data.subscription.unsubscribe();
}

export async function finishSupabaseRedirect() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error && error.name !== 'AuthSessionMissingError') throw error;
  return data.session?.user || null;
}

export function signOutSupabase() { return supabase ? supabase.auth.signOut() : Promise.resolve(); }
