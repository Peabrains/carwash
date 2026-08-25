import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { firebaseConfigured, firestore, finishGoogleRedirect, getFirebaseUser, signInStaffWithGoogle as firebaseGoogleSignIn, signOutStaff as firebaseSignOut, watchFirebaseUser } from './firebase.js';
import * as supabaseApi from './api-supabase.js';

const useSupabase = import.meta.env.VITE_DATA_BACKEND === 'supabase';

export const DEFAULT_PROVIDER_ID = 'washpoint';
export const DEFAULT_LOCATION_ID = 'washpoint-main';
const TENANT_STORAGE_KEY = 'docket.activeTenant';
const MOCK_SETTINGS = {
  min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15,
  weekday_open: '08:00', weekday_close: '19:00', weekend_open: '08:00', weekend_close: '21:00',
};
const MOCK_SERVICES = [
  { id: 'basic', provider_id: DEFAULT_PROVIDER_ID, location_id: DEFAULT_LOCATION_ID, name: 'Basic Wash', duration_minutes: 20, price_myr: 15, is_active: true },
  { id: 'premium', provider_id: DEFAULT_PROVIDER_ID, location_id: DEFAULT_LOCATION_ID, name: 'Premium Wash', duration_minutes: 35, price_myr: 28, is_active: true },
  { id: 'detail', provider_id: DEFAULT_PROVIDER_ID, location_id: DEFAULT_LOCATION_ID, name: 'Full Detail', duration_minutes: 90, price_myr: 90, is_active: true },
];
const MOCK_BAYS = [1, 2, 3].map(number => ({ id: `bay${number}`, provider_id: DEFAULT_PROVIDER_ID, location_id: DEFAULT_LOCATION_ID, name: `Bay ${number}`, is_active: number < 3, status: 'open' }));

let activeTenant = loadTenant();
function loadTenant() {
  try { return JSON.parse(localStorage.getItem(TENANT_STORAGE_KEY)) || { providerId: DEFAULT_PROVIDER_ID, locationId: DEFAULT_LOCATION_ID }; }
  catch { return { providerId: DEFAULT_PROVIDER_ID, locationId: DEFAULT_LOCATION_ID }; }
}
export function getActiveTenant() { return useSupabase ? supabaseApi.getActiveTenant() : { ...activeTenant }; }
export function setActiveTenant(providerId, locationId) {
  if (useSupabase) return supabaseApi.setActiveTenant(providerId, locationId);
  activeTenant = { providerId, locationId };
  localStorage.setItem(TENANT_STORAGE_KEY, JSON.stringify(activeTenant));
  return getActiveTenant();
}
function scope() { return { provider_id: activeTenant.providerId, location_id: activeTenant.locationId }; }
function inScope(item = {}) { return item.provider_id === activeTenant.providerId && item.location_id === activeTenant.locationId; }
function scopedQuery(name) {
  return query(
    collection(firestore, name),
    where('provider_id', '==', activeTenant.providerId),
    where('location_id', '==', activeTenant.locationId)
  );
}
function asDate(value) { return value?.toDate ? value.toDate() : new Date(value); }
function overlaps(startA, endA, startB, endB) { return startA < endB && startB < endA; }
function slug(value) { return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `item-${Date.now()}`; }
function settingsDocId() { return activeTenant.locationId; }
function ensureFirebase() { if (!firebaseConfigured || !firestore) throw new Error('Firebase is not configured.'); }

async function docsFor(name) {
  ensureFirebase();
  const snapshot = await getDocs(scopedQuery(name));
  return snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(inScope);
}
async function appointmentsForDate(dateISO) {
  ensureFirebase();
  const snapshot = await getDocs(query(
    collection(firestore, 'appointments'),
    where('provider_id', '==', activeTenant.providerId),
    where('location_id', '==', activeTenant.locationId),
    where('scheduled_date', '==', dateISO)
  ));
  return snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(inScope);
}

// ── Tenant and staff context ────────────────────────────────────────
export async function getAccessibleTenants(staff) {
  if (useSupabase) return supabaseApi.getAccessibleTenants(staff);
  if (!firebaseConfigured) return {
    providers: [{ id: DEFAULT_PROVIDER_ID, name: 'WashPoint', status: 'active' }],
    locations: [{ id: DEFAULT_LOCATION_ID, provider_id: DEFAULT_PROVIDER_ID, name: 'Main outlet', is_active: true }],
  };
  const platformOwner = staff?.role === 'platform_owner';
  let providers;
  if (platformOwner) {
    providers = (await getDocs(collection(firestore, 'providers'))).docs.map(item => ({ id: item.id, ...item.data() }));
  } else {
    const ids = [...new Set([...(staff?.provider_ids || []), staff?.provider_id || DEFAULT_PROVIDER_ID].filter(Boolean))];
    providers = (await Promise.all(ids.map(id => getDoc(doc(firestore, 'providers', id)))))
      .filter(snapshot => snapshot.exists()).map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
  }
  if (!providers.length && (platformOwner || staff?.provider_id === DEFAULT_PROVIDER_ID || !staff?.provider_id)) {
    providers = [{ id: DEFAULT_PROVIDER_ID, name: 'WashPoint', status: 'active' }];
  }
  const groups = await Promise.all(providers.map(provider => getDocs(query(collection(firestore, 'locations'), where('provider_id', '==', provider.id)))));
  let locations = groups.flatMap(snapshot => snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
  const allowed = new Set([...(staff?.location_ids || []), staff?.location_id].filter(Boolean));
  if (!platformOwner && allowed.size) locations = locations.filter(location => allowed.has(location.id));
  if (!locations.length && providers.some(provider => provider.id === DEFAULT_PROVIDER_ID)) {
    locations = [{ id: DEFAULT_LOCATION_ID, provider_id: DEFAULT_PROVIDER_ID, name: 'Main outlet', is_active: true }];
  }
  const valid = locations.some(location => location.id === activeTenant.locationId && location.provider_id === activeTenant.providerId);
  if (!valid && locations[0]) setActiveTenant(locations[0].provider_id, locations[0].id);
  return { providers, locations };
}
export async function getPlatformAdminData() { if (useSupabase) return supabaseApi.getPlatformAdminData(); return { providers: [], locations: [], staff: [], subscriptions: [], onboarding: [] }; }

export async function createProvider({ name, description = '' }) {
  if (useSupabase) return supabaseApi.createProvider({ name, description });
  ensureFirebase();
  const id = `${slug(name)}-${Math.random().toString(36).slice(2, 7)}`;
  await setDoc(doc(firestore, 'providers', id), { name: name.trim(), description: description.trim(), status: 'active', created_at: new Date().toISOString() });
  return { id, name, status: 'active' };
}
export async function updateProvider(providerId, patch) { if (useSupabase) return supabaseApi.updateProvider(providerId, patch); ensureFirebase(); await updateDoc(doc(firestore, 'providers', providerId), { ...patch, updated_at: new Date().toISOString() }); }
export async function createLocation({ providerId = activeTenant.providerId, name, address = '', timezone = 'Asia/Kuala_Lumpur' }) {
  if (useSupabase) return supabaseApi.createLocation({ providerId, name, address, timezone });
  ensureFirebase();
  const id = `${slug(providerId)}-${slug(name)}-${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(firestore, 'locations', id), { provider_id: providerId, name: name.trim(), address: address.trim(), timezone, is_active: true, created_at: new Date().toISOString() });
  await setDoc(doc(firestore, 'booking_settings', id), { provider_id: providerId, location_id: id, ...MOCK_SETTINGS, created_at: new Date().toISOString() });
  return { id, provider_id: providerId, name, address, timezone, is_active: true };
}
export async function updateLocation(locationId, patch) { if (useSupabase) return supabaseApi.updateLocation(locationId, patch); ensureFirebase(); await updateDoc(doc(firestore, 'locations', locationId), { ...patch, updated_at: new Date().toISOString() }); }
export async function listStaff() {
  if (useSupabase) return supabaseApi.listStaff();
  if (!firebaseConfigured) return [{ id: 'owner@example.com', name: 'Mock Owner', role: 'owner', is_active: true }];
  const snapshot = await getDocs(query(collection(firestore, 'staff'), where('provider_id', '==', activeTenant.providerId)));
  return snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(item => !item.location_id || item.location_id === activeTenant.locationId);
}
export async function saveStaff({ email, name = '', role = 'worker', isActive = true }) {
  if (useSupabase) return supabaseApi.saveStaff({ email, name, role, isActive });
  ensureFirebase();
  const normalized = email.trim().toLowerCase();
  await setDoc(doc(firestore, 'staff', normalized), { email: normalized, name: name.trim() || normalized, role, is_active: isActive, ...scope(), updated_at: new Date().toISOString() }, { merge: true });
  return { id: normalized, email: normalized, name, role, is_active: isActive, ...scope() };
}

// ── Operational data ────────────────────────────────────────────────
export async function getServices({ includeInactive = false } = {}) {
  if (useSupabase) return supabaseApi.getServices({ includeInactive });
  if (!firebaseConfigured) return includeInactive ? MOCK_SERVICES : MOCK_SERVICES.filter(item => item.is_active);
  const values = await docsFor('services');
  return values.filter(item => includeInactive || item.is_active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
export async function saveService({ id, name, durationMinutes, priceMyr, isActive = true }) {
  if (useSupabase) return supabaseApi.saveService({ id, name, durationMinutes, priceMyr, isActive });
  ensureFirebase();
  const payload = { ...scope(), name: name.trim(), duration_minutes: Number(durationMinutes), price_myr: Number(priceMyr), is_active: isActive, updated_at: new Date().toISOString() };
  if (id) { await updateDoc(doc(firestore, 'services', id), payload); return { id, ...payload }; }
  const ref = await addDoc(collection(firestore, 'services'), { ...payload, created_at: new Date().toISOString() });
  return { id: ref.id, ...payload };
}
export async function getActiveBays({ includeInactive = false } = {}) {
  if (useSupabase) return supabaseApi.getActiveBays({ includeInactive });
  if (!firebaseConfigured) return includeInactive ? MOCK_BAYS : MOCK_BAYS.filter(item => item.is_active);
  const values = await docsFor('bays');
  return values.filter(item => includeInactive || item.is_active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}
export async function saveBay({ id, name, isActive = true, status = 'open' }) {
  if (useSupabase) return supabaseApi.saveBay({ id, name, isActive, status });
  ensureFirebase();
  const payload = { ...scope(), name: name.trim(), is_active: isActive, status, updated_at: new Date().toISOString() };
  if (id) { await updateDoc(doc(firestore, 'bays', id), payload); return { id, ...payload }; }
  const ref = await addDoc(collection(firestore, 'bays'), { ...payload, created_at: new Date().toISOString() });
  return { id: ref.id, ...payload };
}

export async function getAppointmentsForDate(dateISO) {
  if (useSupabase) return supabaseApi.getAppointmentsForDate(dateISO);
  if (!firebaseConfigured) return [];
  const [appointments, services, bays] = await Promise.all([appointmentsForDate(dateISO), getServices({ includeInactive: true }), getActiveBays({ includeInactive: true })]);
  const serviceMap = Object.fromEntries(services.map(item => [item.id, item])); const bayMap = Object.fromEntries(bays.map(item => [item.id, item]));
  return appointments.filter(item => item.scheduled_date === dateISO && item.status !== 'cancelled')
    .sort((a, b) => asDate(a.scheduled_at) - asDate(b.scheduled_at))
    .map(item => ({ ...item, services: serviceMap[item.service_id], bays: bayMap[item.bay_id] }));
}

export async function getBayClosuresForDate(dateISO) {
  if (useSupabase) return supabaseApi.getBayClosuresForDate(dateISO);
  if (!firebaseConfigured) return [];
  const [closures, bays] = await Promise.all([docsFor('bay_closures'), getActiveBays({ includeInactive: true })]);
  const bayMap = Object.fromEntries(bays.map(item => [item.id, item]));
  const dayStart = new Date(`${dateISO}T00:00:00+08:00`); const dayEnd = new Date(`${dateISO}T23:59:59+08:00`);
  return closures.filter(item => overlaps(dayStart, dayEnd, asDate(item.starts_at), asDate(item.ends_at)))
    .sort((a, b) => asDate(a.starts_at) - asDate(b.starts_at)).map(item => ({ ...item, bays: bayMap[item.bay_id] }));
}

export async function getBookingSettings() {
  if (useSupabase) return supabaseApi.getBookingSettings();
  if (!firebaseConfigured) return { ...MOCK_SETTINGS, ...scope() };
  // Existing WashPoint data uses booking_settings/main. Read that known
  // document first instead of requesting the newer location-id document,
  // which does not exist and is rejected by Firestore rules before fallback.
  let snapshot = activeTenant.providerId === DEFAULT_PROVIDER_ID && activeTenant.locationId === DEFAULT_LOCATION_ID
    ? await getDoc(doc(firestore, 'booking_settings', 'main'))
    : await getDoc(doc(firestore, 'booking_settings', settingsDocId()));
  if (!snapshot.exists() && activeTenant.providerId === DEFAULT_PROVIDER_ID && activeTenant.locationId === DEFAULT_LOCATION_ID) snapshot = await getDoc(doc(firestore, 'booking_settings', settingsDocId()));
  return snapshot.exists() ? { ...MOCK_SETTINGS, ...snapshot.data() } : { ...MOCK_SETTINGS, ...scope() };
}
export async function updateBookingSettings(patch) {
  if (useSupabase) return supabaseApi.updateBookingSettings(patch);
  if (!firebaseConfigured) return { ...MOCK_SETTINGS, ...patch, ...scope() };
  const payload = { ...patch, ...scope(), updated_at: new Date().toISOString() };
  await setDoc(doc(firestore, 'booking_settings', settingsDocId()), payload, { merge: true });
  if (activeTenant.providerId === DEFAULT_PROVIDER_ID && activeTenant.locationId === DEFAULT_LOCATION_ID) await setDoc(doc(firestore, 'booking_settings', 'main'), payload, { merge: true });
  return getBookingSettings();
}

async function getCrewBreaksForDate(dateISO, bayIds) {
  const values = await getCrewBreaks();
  return values.filter(item => bayIds.includes(item.bay_id)).map(item => {
    const start = new Date(`${dateISO}T${String(item.start_time).slice(0, 5)}:00+08:00`);
    return { ...item, start, end: new Date(start.getTime() + Number(item.duration_minutes) * 60000) };
  });
}
export async function getCrewBreaks() {
  if (useSupabase) return supabaseApi.getCrewBreaks();
  if (!firebaseConfigured) return [];
  const [breaks, bays] = await Promise.all([docsFor('crew_break_schedule'), getActiveBays({ includeInactive: true })]);
  const bayMap = Object.fromEntries(bays.map(item => [item.id, item])); return breaks.map(item => ({ ...item, bays: bayMap[item.bay_id] }));
}
export async function setCrewBreak({ bayId, startTime, durationMinutes }) {
  if (useSupabase) return supabaseApi.setCrewBreak({ bayId, startTime, durationMinutes });
  ensureFirebase();
  const ref = await addDoc(collection(firestore, 'crew_break_schedule'), { ...scope(), bay_id: bayId, start_time: startTime, duration_minutes: Number(durationMinutes), created_at: new Date().toISOString() });
  return { id: ref.id };
}
export async function removeCrewBreak(id) { if (useSupabase) return supabaseApi.removeCrewBreak(id); ensureFirebase(); return deleteDoc(doc(firestore, 'crew_break_schedule', id)); }

export async function getAvailableSlots(dateISO, serviceId, excludeAppointmentId = null) {
  if (useSupabase) return supabaseApi.getAvailableSlots(dateISO, serviceId, excludeAppointmentId);
  if (!firebaseConfigured) return ['09:00', '09:30', '10:00'].map(time => ({ time, available: true, bayId: 'bay1' }));
  const [bays, services, settings, appointments, blackoutDates, closures] = await Promise.all([
    getActiveBays(), getServices(), getBookingSettings(), appointmentsForDate(dateISO), docsFor('blackout_dates'), getBayClosuresForDate(dateISO),
  ]);
  if (blackoutDates.some(item => item.date === dateISO)) return [];
  const service = services.find(item => item.id === serviceId); const openBays = bays.filter(item => !item.status || item.status === 'open');
  if (!service || !openBays.length) return [];
  const toMinutes = value => { const [hours, minutes] = String(value).slice(0, 5).split(':').map(Number); return hours * 60 + minutes; };
  const date = new Date(`${dateISO}T12:00:00+08:00`); const weekend = [0, 6].includes(date.getUTCDay());
  const opening = weekend ? settings.weekend_open : settings.weekday_open; const closing = weekend ? settings.weekend_close : settings.weekday_close;
  const startsAt = toMinutes(opening); const closesAt = toMinutes(closing); const bufferMs = Number(settings.buffer_minutes || 0) * 60000;
  const leadDeadline = Date.now() + Number(settings.min_lead_minutes || 0) * 60000;
  const dayAppointments = appointments.filter(item => item.scheduled_date === dateISO && item.status !== 'cancelled');
  const breaks = await getCrewBreaksForDate(dateISO, openBays.map(item => item.id)); const slots = [];
  for (let minute = startsAt; minute + Number(service.duration_minutes) <= closesAt; minute += 30) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const start = new Date(`${dateISO}T${time}:00+08:00`); const end = new Date(start.getTime() + Number(service.duration_minutes) * 60000);
    if (start.getTime() < leadDeadline) continue;
    const freeBay = openBays.find(bay => {
      const bookingConflict = dayAppointments.some(item => item.bay_id === bay.id && overlaps(start, new Date(end.getTime() + bufferMs), asDate(item.scheduled_at), new Date(asDate(item.scheduled_at).getTime() + Number(item.duration_minutes) * 60000 + bufferMs)));
      const breakConflict = breaks.some(item => item.bay_id === bay.id && overlaps(start, end, item.start, item.end));
      const closureConflict = closures.some(item => item.bay_id === bay.id && overlaps(start, end, asDate(item.starts_at), asDate(item.ends_at)));
      return !bookingConflict && !breakConflict && !closureConflict;
    });
    slots.push({ time, available: Boolean(freeBay), bayId: freeBay?.id });
  }
  return slots;
}

export async function reportBayDown(bayId, { startsAt, endsAt, reason } = {}) {
  if (useSupabase) return supabaseApi.reportBayDown(bayId, { startsAt, endsAt, reason });
  ensureFirebase();
  const closureRef = await addDoc(collection(firestore, 'bay_closures'), { ...scope(), bay_id: bayId, starts_at: startsAt, ends_at: endsAt, reason: reason || null, created_at: new Date().toISOString() });
  const atRisk = (await docsFor('appointments')).filter(item => item.bay_id === bayId && ['pending', 'confirmed'].includes(item.status)
    && overlaps(asDate(item.scheduled_at), new Date(asDate(item.scheduled_at).getTime() + Number(item.duration_minutes) * 60000), asDate(startsAt), asDate(endsAt)));
  for (const appointment of atRisk) {
    const slots = await getAvailableSlots(String(appointment.scheduled_date || appointment.scheduled_at).slice(0, 10), appointment.service_id);
    const time = asDate(appointment.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    const match = slots.find(item => item.time === time && item.available);
    await updateDoc(doc(firestore, 'appointments', appointment.id), match?.bayId ? { bay_id: match.bayId, needs_attention: false } : { needs_attention: true });
  }
  return { flagged: atRisk.length, id: closureRef.id };
}
export async function updateBayClosure(closureId, { startsAt, endsAt, reason } = {}) {
  if (useSupabase) return supabaseApi.updateBayClosure(closureId, { startsAt, endsAt, reason });
  ensureFirebase();
  await updateDoc(doc(firestore, 'bay_closures', closureId), { starts_at: startsAt, ends_at: endsAt, reason: reason || null, updated_at: new Date().toISOString() });
  return { id: closureId, starts_at: startsAt, ends_at: endsAt, reason: reason || null };
}
export async function clearBayClosure(closureId) { if (useSupabase) return supabaseApi.clearBayClosure(closureId); ensureFirebase(); return deleteDoc(doc(firestore, 'bay_closures', closureId)); }
export async function bringBayUp(bayId) { if (useSupabase) return supabaseApi.bringBayUp(bayId); ensureFirebase(); return updateDoc(doc(firestore, 'bays', bayId), { status: 'open', updated_at: new Date().toISOString() }); }
export async function getBookingHistory() { if (useSupabase) return supabaseApi.getBookingHistory(); ensureFirebase(); const values = await docsFor('appointments'); return values.map(item => ({ ...item, events: [] })); }
export async function resolveAppointmentAttention(id, options = {}) { if (useSupabase) return supabaseApi.resolveAppointmentAttention(id, options); ensureFirebase(); return updateDoc(doc(firestore, 'appointments', id), { needs_attention: false, updated_at: new Date().toISOString() }); }
export async function rescheduleAppointment(id, { dateISO, time, bayId } = {}) { if (useSupabase) return supabaseApi.rescheduleAppointment(id, { dateISO, time, bayId }); ensureFirebase(); throw new Error('Rescheduling is currently available in Supabase mode only.'); }
export async function updateAppointmentStatus(id, status, description = '') { if (useSupabase) return supabaseApi.updateAppointmentStatus(id, status, description); ensureFirebase(); return updateDoc(doc(firestore, 'appointments', id), { status, updated_at: new Date().toISOString() }); }
export async function archiveAppointment(id, description = '') { if (useSupabase) return supabaseApi.archiveAppointment(id, description); ensureFirebase(); return updateDoc(doc(firestore, 'appointments', id), { archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }
export function watchOperationalChanges(callback) { return useSupabase ? supabaseApi.watchOperationalChanges(callback) : () => {}; }

// ── Authentication ─────────────────────────────────────────────────
export async function signInStaff() { return useSupabase ? supabaseApi.signInStaff() : (firebaseConfigured ? firebaseGoogleSignIn() : { mock: true }); }
export async function getAuthUser() { return useSupabase ? supabaseApi.getAuthUser() : (firebaseConfigured ? getFirebaseUser() : { id: 'mock-owner', email: 'owner@example.com' }); }
export async function getCurrentStaff() {
  if (useSupabase) return supabaseApi.getCurrentStaff();
  if (!firebaseConfigured) return { id: 'mock-owner', role: 'platform_owner', name: 'Mock Owner', is_active: true };
  const user = await getFirebaseUser(); if (!user?.email) return null;
  const snapshot = await getDoc(doc(firestore, 'staff', user.email.toLowerCase()));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}
export async function signOutStaff() { if (useSupabase) return supabaseApi.signOutStaff(); if (firebaseConfigured) return firebaseSignOut(); }
export function watchStaffAuth(callback) { return useSupabase ? supabaseApi.watchStaffAuth(callback) : (firebaseConfigured ? watchFirebaseUser(callback) : () => {}); }
export async function finishStaffRedirect() { return useSupabase ? supabaseApi.finishStaffRedirect() : (firebaseConfigured ? finishGoogleRedirect() : null); }
