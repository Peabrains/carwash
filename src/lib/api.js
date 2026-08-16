import { supabase, isConfigured } from './supabase.js';

// ── Mock data used until a real Supabase project is connected ──────────
const MOCK_SERVICES = [
  { id: 'basic', name: 'Basic Wash', duration_minutes: 20, price_myr: 15 },
  { id: 'premium', name: 'Premium Wash', duration_minutes: 35, price_myr: 28 },
  { id: 'detail', name: 'Full Detail', duration_minutes: 90, price_myr: 90 }
];
const MOCK_BAYS = [
  { id: 'bay1', name: 'Bay 1', is_active: true },
  { id: 'bay2', name: 'Bay 2', is_active: true },
  { id: 'bay3', name: 'Bay 3', is_active: false }
];
const MOCK_SETTINGS = {
  min_lead_minutes: 60,
  max_advance_days: 14,
  buffer_minutes: 15,
  weekday_open: '08:00', weekday_close: '19:00',
  weekend_open: '08:00', weekend_close: '21:00'
};

export async function getServices() {
  if (!isConfigured) return MOCK_SERVICES;
  const { data, error } = await supabase.from('services').select('*').eq('is_active', true);
  if (error) throw error;
  return data;
}

export async function getActiveBays() {
  if (!isConfigured) return MOCK_BAYS.filter(b => b.is_active);
  // Without an explicit order, Postgres doesn't guarantee row order at
  // all — this is why Bay 2 was showing above Bay 1.
  const { data, error } = await supabase.from('bays').select('*').eq('is_active', true).order('name');
  if (error) throw error;
  return data;
}

// All non-cancelled bookings for a given day, across all bays, for the bay
// board's calendar view. Joins in the bay/service names so the UI doesn't
// need a second round-trip.
export async function getAppointmentsForDate(dateISO) {
  if (!isConfigured) return [];
  const dayStart = new Date(`${dateISO}T00:00:00`);
  const dayEnd = new Date(`${dateISO}T23:59:59`);
  const { data, error } = await supabase
    .from('appointments')
    .select('*, bays(name), services(name)')
    .gte('scheduled_at', dayStart.toISOString())
    .lte('scheduled_at', dayEnd.toISOString())
    .neq('status', 'cancelled')
    .order('scheduled_at');
  if (error) throw error;
  return data;
}

export async function getBayClosuresForDate(dateISO) {
  if (!isConfigured) return [];
  const dayStart = `${dateISO}T00:00:00+08:00`;
  const dayEnd = `${dateISO}T23:59:59+08:00`;
  const { data, error } = await supabase
    .from('bay_closures')
    .select('*, bays(name)')
    .lt('starts_at', dayEnd)
    .gt('ends_at', dayStart)
    .order('starts_at');
  if (error) throw error;
  return data;
}

export async function getBookingSettings() {
  if (!isConfigured) return MOCK_SETTINGS;
  const { data, error } = await supabase.from('booking_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

// Recurring daily crew break per bay, resolved to today's actual time window.
async function getCrewBreaksForDate(dateISO, bayIds) {
  if (!isConfigured) return [];
  const { data, error } = await supabase
    .from('crew_break_schedule')
    .select('bay_id, start_time, duration_minutes')
    .in('bay_id', bayIds);
  if (error) throw error;
  return data.map(b => {
    const start = new Date(`${dateISO}T${b.start_time}`);
    return { bay_id: b.bay_id, start, end: new Date(start.getTime() + b.duration_minutes * 60000) };
  });
}

// Returns a flat list of { time, availableBayId } for a given date + service duration,
// merged across all active bays — customers never pick a bay directly.
// (Called by the Telegram/WhatsApp bot's own booking logic, and internally by
// reportBayDown for reassignment — not by any page in this PWA anymore.)
export async function getAvailableSlots(dateISO, serviceId) {
  if (!isConfigured) {
    // deterministic mock slots for local preview
    const base = ['09:00','09:20','09:40','10:00','10:20','10:40','11:00','11:20','11:40','12:00','12:20','12:40'];
    return base.map((t, i) => ({ time: t, available: i !== 5 && i !== 9 }));
  }
  const bays = (await getActiveBays()).filter(b => b.status === 'open');
  const service = (await getServices()).find(s => s.id === serviceId);
  const settings = await getBookingSettings();
  const bufferMs = settings.buffer_minutes * 60000;
  const dayStart = new Date(`${dateISO}T00:00:00`);
  const dayEnd = new Date(`${dateISO}T23:59:59`);

  const { data: existing, error } = await supabase
    .from('appointments')
    .select('bay_id, scheduled_at, duration_minutes')
    .in('bay_id', bays.map(b => b.id))
    .gte('scheduled_at', dayStart.toISOString())
    .lte('scheduled_at', dayEnd.toISOString())
    .in('status', ['pending', 'confirmed', 'in_progress']);
  if (error) throw error;

  const breaks = await getCrewBreaksForDate(dateISO, bays.map(b => b.id));
  const closures = await getBayClosuresForDate(dateISO);

  // NOTE: still uses a hardcoded 9am-7pm scan window and doesn't yet respect
  // weekday/weekend hours or blackout_dates — same simplification as before,
  // unrelated to the buffer/crew-break work done here.
  const slots = [];
  for (let mins = 9 * 60; mins < 19 * 60; mins += 20) {
    const time = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const slotStart = new Date(`${dateISO}T${time}:00`);
    const slotEnd = new Date(slotStart.getTime() + service.duration_minutes * 60000);

    const freeBay = bays.find(bay => {
      // Existing bookings on this bay occupy duration + buffer — the buffer
      // is applied here (at check time, from current settings) rather than
      // stored per-row, and only extends the far end, so back-to-back slots
      // separated by exactly one buffer never double it up.
      const bookingConflict = existing.filter(a => a.bay_id === bay.id).some(a => {
        const aStart = new Date(a.scheduled_at);
        const aEndWithBuffer = new Date(aStart.getTime() + a.duration_minutes * 60000 + bufferMs);
        return slotStart < aEndWithBuffer && aStart < slotEnd;
      });
      if (bookingConflict) return false;

      // Crew breaks are the rest period itself, so no buffer inflation needed.
      const breakConflict = breaks.some(b => b.bay_id === bay.id && slotStart < b.end && b.start < slotEnd);
      const closureConflict = closures.some(c => c.bay_id === bay.id && slotStart < new Date(c.ends_at) && new Date(c.starts_at) < slotEnd);
      return !breakConflict && !closureConflict;
    });

    slots.push({ time, available: Boolean(freeBay), bayId: freeBay?.id });
  }
  return slots;
}

// ── Staff-side ───────────────────────────────────────────────────────
export async function reportBayDown(bayId, { startsAt, endsAt, reason } = {}) {
  if (!isConfigured) return { flagged: 0, id: 'mock' };
  const { data: closure, error: closureError } = await supabase
    .from('bay_closures')
    .insert({ bay_id: bayId, starts_at: startsAt, ends_at: endsAt, reason: reason || null })
    .select()
    .single();
  if (closureError) throw closureError;

  // Reassign appointments overlapping the outage where another open bay can take them.
  const { data: atRisk } = await supabase
    .from('appointments')
    .select('*')
    .eq('bay_id', bayId)
    .lt('scheduled_at', endsAt)
    .gte('scheduled_at', startsAt)
    .in('status', ['pending', 'confirmed']);

  for (const appt of atRisk ?? []) {
    const slots = await getAvailableSlots(appt.scheduled_at.slice(0, 10), appt.service_id);
    const match = slots.find(s => s.time === appt.scheduled_at.slice(11, 16) && s.available);
    if (match?.bayId) {
      await supabase.from('appointments').update({ bay_id: match.bayId }).eq('id', appt.id);
    } else {
      await supabase.from('appointments').update({ needs_attention: true }).eq('id', appt.id);
    }
  }
  return { flagged: (atRisk ?? []).length, id: closure.id };
}

export async function clearBayClosure(closureId) {
  if (!isConfigured) return;
  const { error } = await supabase.from('bay_closures').delete().eq('id', closureId);
  if (error) throw error;
}

export async function bringBayUp(bayId) {
  if (!isConfigured) return;
  const { error } = await supabase.from('bays').update({ status: 'open' }).eq('id', bayId);
  if (error) throw error;
}

export async function updateBookingSettings(patch) {
  if (!isConfigured) return { ...MOCK_SETTINGS, ...patch };
  const { data, error } = await supabase.from('booking_settings').update(patch).eq('id', 1).select().single();
  if (error) throw error;
  return data;
}

export async function getCrewBreaks() {
  if (!isConfigured) return [];
  const { data, error } = await supabase.from('crew_break_schedule').select('*, bays(name)');
  if (error) throw error;
  return data;
}

export async function setCrewBreak({ bayId, startTime, durationMinutes }) {
  if (!isConfigured) return { id: 'mock' };
  const { data, error } = await supabase.from('crew_break_schedule')
    .insert({ bay_id: bayId, start_time: startTime, duration_minutes: durationMinutes })
    .select().single();
  if (error) throw error;
  return data;
}

export async function removeCrewBreak(id) {
  if (!isConfigured) return;
  const { error } = await supabase.from('crew_break_schedule').delete().eq('id', id);
  if (error) throw error;
}

// ── Staff auth ───────────────────────────────────────────────────────
// Email+password rather than magic link — avoids depending on email
// delivery entirely (no rate limits, no redirect-URL config, no device
// mismatch). Fine for a small, known staff list; revisit if self-serve
// signup for arbitrary users is ever needed.
export async function signInStaff(email, password) {
  if (!isConfigured) return { mock: true };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function getAuthUser() {
  if (!isConfigured) return { id: 'mock-owner' };
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Distinguishes "no session at all" from "signed in but not on the staff
// list" — the two need different messages/actions in the UI.
export async function getCurrentStaff() {
  if (!isConfigured) return { id: 'mock-owner', role: 'owner', name: 'Mock Owner' };
  const user = await getAuthUser();
  if (!user) return null;
  const { data, error } = await supabase.from('staff').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  return data; // null if authenticated but not yet added to the staff table
}

export async function signOutStaff() {
  if (!isConfigured) return;
  await supabase.auth.signOut();
}
