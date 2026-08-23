import { supabase, supabaseConfigured, finishSupabaseRedirect, getSupabaseUser, signInStaffWithGoogle as supabaseGoogleSignIn, signOutSupabase, watchSupabaseUser } from './supabase.js';

export const DEFAULT_PROVIDER_ID = 'washpoint';
export const DEFAULT_LOCATION_ID = 'washpoint-main';

const MOCK_SETTINGS = { min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15, weekday_open: '08:00', weekday_close: '19:00', weekend_open: '08:00', weekend_close: '21:00' };
const TENANT_STORAGE_KEY = 'docket.activeTenant';
let activeTenant = loadTenant();

function loadTenant() { try { return JSON.parse(localStorage.getItem(TENANT_STORAGE_KEY)) || { providerId: DEFAULT_PROVIDER_ID, locationId: DEFAULT_LOCATION_ID }; } catch { return { providerId: DEFAULT_PROVIDER_ID, locationId: DEFAULT_LOCATION_ID }; } }
function ensureSupabase() { if (!supabaseConfigured || !supabase) throw new Error('Supabase is not configured.'); return supabase; }
function scope() { return { provider_id: activeTenant.providerId, location_id: activeTenant.locationId }; }
function errorOrThrow(error, operation) { if (error) throw new Error(`Supabase ${operation} failed: ${error.message || 'unknown error'}`); }
function asDate(value) { return value?.toDate ? value.toDate() : new Date(value); }
function overlaps(startA, endA, startB, endB) { return startA < endB && startB < endA; }
function minutes(value) { const [hours, mins] = String(value).slice(0, 5).split(':').map(Number); return hours * 60 + mins; }
function localDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function isBookable(dateISO, settings) { const today = localDate(); const start = new Date(`${today}T00:00:00+08:00`); const date = new Date(`${dateISO}T00:00:00+08:00`); const days = Math.round((date - start) / 86400000); return days >= 0 && days <= Number(settings.max_advance_days || 14); }
async function rows(table, columns = '*') { const db = ensureSupabase(); const { data, error } = await db.from(table).select(columns).eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId); errorOrThrow(error, `loading ${table}`); return data || []; }

export const isSupabaseMode = true;
export function getActiveTenant() { return { ...activeTenant }; }
export function setActiveTenant(providerId, locationId) { activeTenant = { providerId, locationId }; localStorage.setItem(TENANT_STORAGE_KEY, JSON.stringify(activeTenant)); return getActiveTenant(); }

export async function getAccessibleTenants() {
  const db = ensureSupabase();
  const [{ data: providers, error: providerError }, { data: locations, error: locationError }] = await Promise.all([
    db.from('providers').select('*').order('name'),
    db.from('locations').select('*').eq('is_active', true).order('name'),
  ]);
  errorOrThrow(providerError, 'loading providers'); errorOrThrow(locationError, 'loading locations');
  const valid = (locations || []).some(item => item.id === activeTenant.locationId && item.provider_id === activeTenant.providerId);
  if (!valid && locations?.[0]) setActiveTenant(locations[0].provider_id, locations[0].id);
  return { providers: providers || [], locations: locations || [] };
}

export async function createProvider({ name, description = '' }) { const db = ensureSupabase(); const { data, error } = await db.from('providers').insert({ id: name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-'), name: name.trim(), description: description.trim(), status: 'active' }).select().single(); errorOrThrow(error, 'creating provider'); return data; }
export async function updateProvider(providerId, patch) { const db = ensureSupabase(); const { data, error } = await db.from('providers').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', providerId).select().single(); errorOrThrow(error, 'updating provider'); return data; }
export async function createLocation({ providerId = activeTenant.providerId, name, address = '', timezone = 'Asia/Kuala_Lumpur' }) { const db = ensureSupabase(); const id = `${providerId}-${name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')}`; const { data, error } = await db.from('locations').insert({ id, provider_id: providerId, name: name.trim(), address: address.trim(), timezone, is_active: true }).select().single(); errorOrThrow(error, 'creating location'); await db.from('booking_settings').upsert({ id: Date.now(), provider_id: providerId, location_id: id, ...MOCK_SETTINGS }); return data; }
export async function updateLocation(locationId, patch) { const db = ensureSupabase(); const { data, error } = await db.from('locations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', locationId).select().single(); errorOrThrow(error, 'updating location'); return data; }
export async function listStaff() { const db = ensureSupabase(); const { data, error } = await db.from('staff').select('*').eq('provider_id', activeTenant.providerId).or(`location_id.is.null,location_id.eq.${activeTenant.locationId}`).order('email'); errorOrThrow(error, 'loading staff'); return data || []; }
export async function saveStaff({ email, name = '', role = 'worker', isActive = true }) { const db = ensureSupabase(); const normalized = email.trim().toLowerCase(); const { data: existing, error: lookupError } = await db.from('staff').select('id').eq('email', normalized).maybeSingle(); errorOrThrow(lookupError, 'looking up staff'); if (!existing) throw new Error('This staff member must sign in with Google once before being added.'); const { data, error } = await db.from('staff').update({ name: name.trim() || normalized, role, is_active: isActive, ...scope(), updated_at: new Date().toISOString() }).eq('id', existing.id).select().single(); errorOrThrow(error, 'saving staff'); return data; }

export async function getServices({ includeInactive = false } = {}) { const db = ensureSupabase(); let request = db.from('services').select('*').eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).order('name'); if (!includeInactive) request = request.eq('is_active', true); const { data, error } = await request; errorOrThrow(error, 'loading services'); return data || []; }
export async function saveService({ id, name, durationMinutes, priceMyr, isActive = true }) { const db = ensureSupabase(); const payload = { ...scope(), name: name.trim(), duration_minutes: Number(durationMinutes), price_myr: Number(priceMyr), is_active: isActive, updated_at: new Date().toISOString() }; const { data, error } = id ? await db.from('services').update(payload).eq('id', id).select().single() : await db.from('services').insert(payload).select().single(); errorOrThrow(error, 'saving service'); return data; }
export async function getActiveBays({ includeInactive = false } = {}) { const db = ensureSupabase(); let request = db.from('bays').select('*').eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).order('name'); if (!includeInactive) request = request.eq('is_active', true); const { data, error } = await request; errorOrThrow(error, 'loading bays'); return data || []; }
export async function saveBay({ id, name, isActive = true, status = 'open' }) { const db = ensureSupabase(); const payload = { ...scope(), name: name.trim(), is_active: isActive, status, updated_at: new Date().toISOString() }; const { data, error } = id ? await db.from('bays').update(payload).eq('id', id).select().single() : await db.from('bays').insert(payload).select().single(); errorOrThrow(error, 'saving bay'); return data; }

export async function getAppointmentsForDate(dateISO) { const db = ensureSupabase(); const [{ data: appointments, error: appointmentError }, services, bays] = await Promise.all([db.from('appointments').select('*').eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).eq('scheduled_date', dateISO).neq('status', 'cancelled').order('scheduled_at'), getServices({ includeInactive: true }), getActiveBays({ includeInactive: true })]); errorOrThrow(appointmentError, 'loading appointments'); const serviceMap = Object.fromEntries(services.map(item => [item.id, item])); const bayMap = Object.fromEntries(bays.map(item => [item.id, item])); return (appointments || []).map(item => ({ ...item, services: serviceMap[item.service_id], bays: bayMap[item.bay_id] })); }
export async function getBayClosuresForDate(dateISO) { const db = ensureSupabase(); const { data, error } = await db.from('bay_closures').select('*').eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).lt('starts_at', `${dateISO}T23:59:59+08:00`).gt('ends_at', `${dateISO}T00:00:00+08:00`).order('starts_at'); errorOrThrow(error, 'loading bay closures'); const bays = await getActiveBays({ includeInactive: true }); const bayMap = Object.fromEntries(bays.map(item => [item.id, item])); return (data || []).map(item => ({ ...item, bays: bayMap[item.bay_id] })); }
export async function getBookingSettings() { const db = ensureSupabase(); const { data, error } = await db.from('booking_settings').select('*').eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).maybeSingle(); errorOrThrow(error, 'loading booking settings'); return { ...MOCK_SETTINGS, ...scope(), ...(data || {}) }; }
export async function updateBookingSettings(patch) { const db = ensureSupabase(); const { data, error } = await db.from('booking_settings').update({ ...patch, ...scope(), updated_at: new Date().toISOString() }).eq('provider_id', activeTenant.providerId).eq('location_id', activeTenant.locationId).select().single(); errorOrThrow(error, 'updating booking settings'); return data; }
export async function getCrewBreaks() { const bays = await getActiveBays({ includeInactive: true }); const bayMap = Object.fromEntries(bays.map(item => [item.id, item])); return (await rows('crew_break_schedule')).map(item => ({ ...item, bays: bayMap[item.bay_id] })); }
export async function setCrewBreak({ bayId, startTime, durationMinutes }) { const db = ensureSupabase(); const { data, error } = await db.from('crew_break_schedule').insert({ ...scope(), bay_id: bayId, start_time: startTime, duration_minutes: Number(durationMinutes) }).select().single(); errorOrThrow(error, 'creating crew break'); return data; }
export async function removeCrewBreak(id) { const db = ensureSupabase(); const { error } = await db.from('crew_break_schedule').delete().eq('id', id); errorOrThrow(error, 'deleting crew break'); }

export async function getAvailableSlots(dateISO, serviceId) {
  const [bays, services, settings, appointments, closures, breaks] = await Promise.all([getActiveBays(), getServices(), getBookingSettings(), getAppointmentsForDate(dateISO), getBayClosuresForDate(dateISO), getCrewBreaks()]);
  const service = services.find(item => item.id === serviceId); if (!service || !isBookable(dateISO, settings)) return [];
  const date = new Date(`${dateISO}T12:00:00+08:00`); const weekend = [0, 6].includes(date.getUTCDay()); const opening = weekend ? settings.weekend_open : settings.weekday_open; const closing = weekend ? settings.weekend_close : settings.weekday_close; const slots = [];
  for (let minute = minutes(opening); minute + Number(service.duration_minutes) <= minutes(closing); minute += 30) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; const start = new Date(`${dateISO}T${time}:00+08:00`); const end = new Date(start.getTime() + Number(service.duration_minutes) * 60000); if (start.getTime() < Date.now() + Number(settings.min_lead_minutes) * 60000) continue;
    const freeBay = bays.find(bay => (!bay.status || bay.status === 'open') && !appointments.some(item => item.bay_id === bay.id && overlaps(start, new Date(end.getTime() + Number(settings.buffer_minutes || 0) * 60000), asDate(item.scheduled_at), new Date(asDate(item.scheduled_at).getTime() + Number(item.duration_minutes) * 60000 + Number(settings.buffer_minutes || 0) * 60000))) && !breaks.some(item => item.bay_id === bay.id && overlaps(start, end, new Date(`${dateISO}T${String(item.start_time).slice(0, 5)}:00+08:00`), new Date(new Date(`${dateISO}T${String(item.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(item.duration_minutes) * 60000))) && !closures.some(item => item.bay_id === bay.id && overlaps(start, end, asDate(item.starts_at), asDate(item.ends_at))));
    slots.push({ time, available: Boolean(freeBay), bayId: freeBay?.id });
  }
  return slots;
}

export async function resolveAppointmentAttention(id) { const db = ensureSupabase(); const { data, error } = await db.from('appointments').update({ needs_attention: false, updated_at: new Date().toISOString() }).eq('id', id).select().single(); errorOrThrow(error, 'resolving appointment attention'); return data; }
export async function rescheduleAppointment(id, { dateISO, time } = {}) { const db = ensureSupabase(); const { data: current, error: currentError } = await db.from('appointments').select('id,service_id').eq('id', id).single(); errorOrThrow(currentError, 'loading appointment for rescheduling'); const slots = await getAvailableSlots(dateISO, current.service_id); const slot = slots.find(item => item.time === time && item.available && item.bayId); if (!slot) throw new Error('That time is no longer available.'); const scheduledAt = new Date(`${dateISO}T${time}:00+08:00`).toISOString(); const { data, error } = await db.from('appointments').update({ scheduled_date: dateISO, scheduled_at: scheduledAt, bay_id: slot.bayId, needs_attention: false, updated_at: new Date().toISOString() }).eq('id', id).select().single(); errorOrThrow(error, 'rescheduling appointment'); return data; }

export async function reportBayDown(bayId, { startsAt, endsAt, reason } = {}) { const db = ensureSupabase(); const { data, error } = await db.from('bay_closures').insert({ ...scope(), bay_id: bayId, starts_at: startsAt, ends_at: endsAt, reason: reason || null }).select().single(); errorOrThrow(error, 'reporting bay outage'); const start = new Date(startsAt); const end = new Date(endsAt); const dateISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(start); const appointments = await getAppointmentsForDate(dateISO); const atRisk = appointments.filter(item => item.bay_id === bayId && item.status !== 'cancelled' && overlaps(start, end, asDate(item.scheduled_at), new Date(asDate(item.scheduled_at).getTime() + Number(item.duration_minutes) * 60000))); await Promise.all(atRisk.map(item => db.from('appointments').update({ needs_attention: true, updated_at: new Date().toISOString() }).eq('id', item.id))); return { flagged: atRisk.length, id: data.id }; }
export async function updateBayClosure(closureId, { startsAt, endsAt, reason } = {}) { const db = ensureSupabase(); const { data, error } = await db.from('bay_closures').update({ starts_at: startsAt, ends_at: endsAt, reason: reason || null }).eq('id', closureId).select().single(); errorOrThrow(error, 'updating bay outage'); return data; }
export async function clearBayClosure(closureId) { const db = ensureSupabase(); const { data, error } = await db.from('bay_closures').delete().eq('id', closureId).select('id'); errorOrThrow(error, 'clearing bay outage'); if (!data?.length) throw new Error('The outage was not deleted. It may already be gone or you may not have permission.'); }
export async function bringBayUp(bayId) { const db = ensureSupabase(); const { data, error } = await db.from('bays').update({ status: 'open', updated_at: new Date().toISOString() }).eq('id', bayId).select().single(); errorOrThrow(error, 'bringing bay back up'); return data; }

export async function signInStaff() { return supabaseGoogleSignIn(); }
export async function getAuthUser() { return getSupabaseUser(); }
export async function getCurrentStaff() { const user = await getSupabaseUser(); if (!user) return null; const db = ensureSupabase(); const { data, error } = await db.from('staff').select('*').eq('id', user.id).maybeSingle(); errorOrThrow(error, 'loading current staff'); return data; }
export async function signOutStaff() { return signOutSupabase(); }
export function watchStaffAuth(callback) { return watchSupabaseUser(callback); }
export async function finishStaffRedirect() { return finishSupabaseRedirect(); }
