import { createClient } from '@supabase/supabase-js';

const viteEnv = import.meta.env || {};
const url = viteEnv.VITE_SUPABASE_URL;
const key = viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY || viteEnv.VITE_SUPABASE_ANON_KEY;

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

export function buildProviderOwnerSignup({ email, password }) {
  const baseUrl = redirectUrl();
  return {
    email: String(email || '').trim().toLowerCase(),
    password,
    options: { emailRedirectTo: `${baseUrl}#/provider/onboarding` },
  };
}

export async function signUpProviderOwner({ email, password }) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.signUp(buildProviderOwnerSignup({ email, password }));
  if (error) throw error;
  return data;
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

export async function linkStaffGoogleIdentity() {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.linkIdentity({
    provider: 'google',
    options: { redirectTo: `${redirectUrl()}?staff_invite=1#/staff/setup` },
  });
  if (error) throw error;
  return data;
}

export async function signInStaffWithPassword(email, password) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw error;
  return data;
}

export async function signUpStaffWithPassword(email, password) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { emailRedirectTo: redirectUrl() },
  });
  if (error) throw error;
  return data;
}

export async function sendStaffPasswordReset(email) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  // Keep the recovery callback outside the hash router. Supabase returns the
  // recovery tokens in the URL fragment, so nesting our route in the same
  // fragment makes the router mistake the callback for a normal page visit.
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${redirectUrl()}?staff_reset=1` });
  if (error) throw error;
}

export async function updateStaffPassword(password) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
  return data;
}

export async function signUpCustomer(email, password) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { emailRedirectTo: `${redirectUrl()}#/account` },
  });
  if (error) throw error;
  return data;
}

export async function signInCustomer(email, password) {
  return signInStaffWithPassword(email, password);
}

export async function sendCustomerPasswordReset(email) {
  if (!supabase) throw new Error('Supabase Authentication is not configured.');
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${redirectUrl()}?customer_reset=1` });
  if (error) throw error;
}

export async function updateCustomerPassword(password) {
  return updateStaffPassword(password);
}

export async function getCustomerProfile(user) {
  if (!supabase || !user) return null;
  const { data, error } = await supabase.from('customer_profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveCustomerProfile(user, values) {
  if (!supabase || !user) throw new Error('Please sign in first.');
  const { data, error } = await supabase.from('customer_profiles').upsert({
    user_id: user.id,
    name: String(values.name || '').trim(),
    phone: String(values.phone || '').trim(),
    preferences: values.preferences || {},
    updated_at: new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

export async function getCustomerVehicles(user) {
  if (!supabase || !user) return [];
  const { data, error } = await supabase.from('customer_vehicles').select('*').eq('user_id', user.id).order('is_default', { ascending: false }).order('created_at');
  if (error) throw error;
  return data || [];
}

export async function saveCustomerVehicle(user, values) {
  if (!supabase || !user) throw new Error('Please sign in first.');
  const row = { user_id: user.id, plate: String(values.plate || '').trim().toUpperCase(), make_model: String(values.makeModel || '').trim(), category: String(values.category || '').trim() || null, is_default: Boolean(values.isDefault), updated_at: new Date().toISOString() };
  if (row.is_default) {
    const { error: defaultError } = await supabase.from('customer_vehicles').update({ is_default: false }).eq('user_id', user.id);
    if (defaultError) throw defaultError;
  }
  const query = values.id ? supabase.from('customer_vehicles').update(row).eq('id', values.id).eq('user_id', user.id) : supabase.from('customer_vehicles').insert(row);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}

export async function deleteCustomerVehicle(user, id) {
  if (!supabase || !user) throw new Error('Please sign in first.');
  const { error } = await supabase.from('customer_vehicles').delete().eq('id', id).eq('user_id', user.id);
  if (error) throw error;
}

export async function getCustomerBookings(user) {
  if (!supabase || !user) return [];
  const { data, error } = await supabase.from('appointments').select('id,reference,provider_id,location_id,service_id,scheduled_at,scheduled_date,status,vehicle_plate,vehicle_make_model,price_myr,created_at').eq('customer_user_id', user.id).order('scheduled_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getSupabaseUser() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error && error.name !== 'AuthSessionMissingError') throw error;
  return data.user || null;
}

export async function getSupabaseAccessToken() {
  if (!supabase) return '';
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.access_token || '';
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
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) throw error;
    const route = url.searchParams.has('customer_reset') ? '#/account/reset-password' : (hashParams.get('type') === 'recovery' || url.searchParams.has('staff_reset') ? '#/staff/reset-password' : '#/');
    url.searchParams.delete('staff_reset');
    url.searchParams.delete('customer_reset');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${route}`);
    return data.user || null;
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
