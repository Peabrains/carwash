import { supabase, isConfigured } from './supabase.js';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { firestore, firebaseConfigured } from './firebase.js';

// ── Mock data used until a real Supabase project is connected ──────────
const MOCK_SERVICES = [
  { id: 'basic', name: 'Basic Wash', duration_minutes: 20, price_myr: 15 },
  { id: 'premium', name: 'Premium Wash', duration_minutes: 35, price_myr: 28 },
  { id: 'detail', name: 'Full Detail', duration_minutes: 90, price_myr: 90 }
];
const MOCK_BAYS = [
  { id: 'bay1', name: 'Bay 1', is_active: true },
  { id: 'bay2', name: 'Bay 2', is_active: true },
  { id: 'bay3', name: 'Bay 3', is_active: false },
  { id: 'bay4', name: 'Bay 4', is_active: true }
];
const MOCK_SETTINGS = {
  min_lead_minutes: 60,
  max_advance_days: 14,
  weekday_open: '08:00', weekday_close: '19:00',
  weekend_open: '08:00', weekend_close: '21:00'
};

export async function getServices() {
  // Prefer Firebase once its catalogue has been populated. Until then,
  // retain the Supabase path so the live app remains usable during migration.
  if (firebaseConfigured) {
    try {
      const snapshot = await getDocs(query(collection(firestore, 'services'), where('is_active', '==', true)));
      if (!snapshot.empty) return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.warn('Firebase catalogue unavailable; using the existing data source during migration.', error);
    }
  }
  if (!isConfigured) return MOCK_SERVICES;
  const { data, error } = await supabase.from('services').select('*').eq('is_active', true);
  if (error) throw error;
  return data;
}

export async function getActiveBays() {
  if (firebaseConfigured) {
    try {
      const snapshot = await getDocs(query(collection(firestore, 'bays'), where('is_active', '==', true)));
      if (!snapshot.empty) return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.warn('Firebase bays unavailable; using the existing data source during migration.', error);
    }
  }
  if (!isConfigured) return MOCK_BAYS.filter(b => b.is_active);
  const { data, error } = await supabase.from('bays').select('*').eq('is_active', true);
  if (error) throw error;
  return data;
}

export async function getBookingSettings() {
  if (firebaseConfigured) {
    try {
      const snapshot = await getDoc(doc(firestore, 'booking_settings', 'main'));
      if (snapshot.exists()) return snapshot.data();
    } catch (error) {
      console.warn('Firebase booking settings unavailable; using the existing data source during migration.', error);
    }
  }
  if (!isConfigured) return MOCK_SETTINGS;
  const { data, error } = await supabase.from('booking_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

// Returns a flat list of { time, availableBayId } for a given date + service duration,
// merged across all active bays — customers never pick a bay directly.
export async function getAvailableSlots(dateISO, serviceId) {
  if (!isConfigured) {
    // deterministic mock slots for local preview
    const base = ['09:00','09:20','09:40','10:00','10:20','10:40','11:00','11:20','11:40','12:00','12:20','12:40'];
    return base.map((t, i) => ({ time: t, available: i !== 5 && i !== 9 }));
  }
  const bays = await getActiveBays();
  const service = (await getServices()).find(s => s.id === serviceId);
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

  // naive slot generation — real implementation should also respect operating hours,
  // blackout_dates, and bay_closures for the date in question
  const slots = [];
  for (let mins = 9 * 60; mins < 19 * 60; mins += 20) {
    const time = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const slotStart = new Date(`${dateISO}T${time}:00`);
    const slotEnd = new Date(slotStart.getTime() + service.duration_minutes * 60000);

    const freeBay = bays.find(bay => {
      const conflicts = existing.filter(a => a.bay_id === bay.id).some(a => {
        const aStart = new Date(a.scheduled_at);
        const aEnd = new Date(aStart.getTime() + a.duration_minutes * 60000);
        return slotStart < aEnd && aStart < slotEnd;
      });
      return !conflicts;
    });

    slots.push({ time, available: Boolean(freeBay), bayId: freeBay?.id });
  }
  return slots;
}

export async function createAppointment({ customerId, vehicleId, serviceId, bayId, scheduledAtISO }) {
  const service = (await getServices()).find(s => s.id === serviceId);
  const reference = `WP-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(Math.random()*9000+1000)}`;

  if (firebaseConfigured) {
    const response = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_id: customerId,
        vehicle_id: vehicleId,
        service_id: serviceId,
        scheduled_at: scheduledAtISO
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Unable to create appointment');
    return body;
  }

  if (!isConfigured) {
    return { id: 'mock', reference, status: 'pending', payment_status: 'unpaid' };
  }
  const { data, error } = await supabase.from('appointments').insert({
    customer_id: customerId,
    vehicle_id: vehicleId,
    bay_id: bayId,
    service_id: serviceId,
    scheduled_at: scheduledAtISO,
    duration_minutes: service.duration_minutes,
    price_myr: service.price_myr,
    reference
  }).select().single();
  if (error) throw error;
  return data;
}

export async function getMyAppointments(customerId) {
  if (!isConfigured) {
    return [
      { id: 1, service_name: 'Premium Wash', scheduled_at: '2026-08-06T10:20:00', bay_name: 'Bay 2', price_myr: 28, status: 'completed' },
      { id: 2, service_name: 'Basic Wash', scheduled_at: '2026-07-22T09:00:00', bay_name: 'Bay 1', price_myr: 15, status: 'completed' }
    ];
  }
  const { data, error } = await supabase
    .from('appointments')
    .select('id, scheduled_at, price_myr, status, services(name), bays(name)')
    .eq('customer_id', customerId)
    .order('scheduled_at', { ascending: false });
  if (error) throw error;
  return data;
}

// ── Staff-side ───────────────────────────────────────────────────────
export async function reportBayDown(bayId, { reason } = {}) {
  if (!isConfigured) return { flagged: 0 };
  // Close the bay going forward
  await supabase.from('bays').update({ status: 'maintenance' }).eq('id', bayId);

  // Flag today's remaining appointments on this bay that couldn't be auto-reassigned
  const now = new Date().toISOString();
  const { data: atRisk } = await supabase
    .from('appointments')
    .select('*')
    .eq('bay_id', bayId)
    .gte('scheduled_at', now)
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
  return { flagged: (atRisk ?? []).length };
}

export async function updateBookingSettings(patch) {
  if (!isConfigured) return { ...MOCK_SETTINGS, ...patch };
  const { data, error } = await supabase.from('booking_settings').update(patch).eq('id', 1).select().single();
  if (error) throw error;
  return data;
}
