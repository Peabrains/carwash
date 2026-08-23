import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && key);
export const supabase = supabaseConfigured
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

function redirectUrl() {
  // Supabase's redirect allow-list matches the app URL, not the hash-router
  // route. The callback handler below restores the session, then the app's
  // router sends the signed-in user to the board.
  return `${window.location.origin}${window.location.pathname}`;
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
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
    return data.session?.user || null;
  }
  const { data, error } = await supabase.auth.getSession();
  if (error && error.name !== 'AuthSessionMissingError') throw error;
  return data.session?.user || null;
}

export function signOutSupabase() { return supabase ? supabase.auth.signOut() : Promise.resolve(); }

export function watchOperationalChanges(providerId, locationId, callback) {
  if (!supabase) return () => {};
  const channel = supabase.channel(`docket-board-${providerId}-${locationId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `provider_id=eq.${providerId}` }, callback)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bay_closures', filter: `provider_id=eq.${providerId}` }, callback)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bays', filter: `provider_id=eq.${providerId}` }, callback)
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
