import "./env.js";
import { createHash, randomUUID } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Channel, Thread } from "chat";
import { Actions, Button, Card, CardText } from "chat";
import { bookingIntervalsOverlap, intervalsOverlap, isDateBookable } from "./booking-rules.js";
import { availableSupabaseSlots, loadSupabaseBookingContext, reserveSupabaseAppointment, supabaseConfigured } from "./supabase-booking.js";

export type Tier1State = {
  step: "service" | "date" | "time" | "name" | "phone" | "plate" | "vehicle" | "confirm" | "submitting" | "completed";
  serviceId?: string;
  serviceName?: string;
  durationMinutes?: number;
  priceMyr?: number;
  dateIso?: string;
  time24h?: string;
  customerName?: string;
  customerPhone?: string;
  vehiclePlate?: string;
  vehicleMakeModel?: string;
  bookingRequestId?: string;
  lastActiveAt?: string;
};

type TenantScoped = { provider_id?: string; location_id?: string };
export type Service = TenantScoped & { id: string; name: string; duration_minutes: number; price_myr: number };
export type Settings = { min_lead_minutes: number; max_advance_days: number; buffer_minutes: number; weekday_open: string; weekday_close: string; weekend_open: string; weekend_close: string };
export type BookingContext = { services: Service[]; settings: Settings };

function firebaseDb() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
  return getFirestore();
}
const firestore = firebaseDb();
const providerId = process.env.TIER1_PROVIDER_ID || "washpoint";
const locationId = process.env.TIER1_LOCATION_ID || "washpoint-main";
const useSupabase = process.env.BOOKING_DATA_BACKEND === "supabase";
const fallback: Settings = { min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15, weekday_open: "08:00", weekday_close: "19:00", weekend_open: "08:00", weekend_close: "21:00" };

function localDate(date = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function addDays(dateIso: string, days: number) { const d = new Date(`${dateIso}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function mins(value: string) { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00+08:00`)); }
function formatShortDate(value: string) { return new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric" }).format(new Date(`${value}T12:00:00+08:00`)); }
function serviceLabel(service: Service) { return `${service.name} — ${service.duration_minutes} min, RM${service.price_myr}`; }
function phone(value: string) { return value.match(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/)?.[0].replace(/[\s-]/g, ""); }
function isYes(value: string) { return /^(yes|y|confirm|confirmed|ya|betul|ok|okay)$/i.test(value.trim()); }
function isNo(value: string) { return /^(no|n|cancel|batal|restart|mula baru)$/i.test(value.trim()); }
function inCurrentLocation<T extends TenantScoped>(value: T) {
  return value.provider_id === providerId && value.location_id === locationId;
}
function asMillis(value: unknown) {
  return value && typeof value === "object" && "toDate" in value
    ? (value as { toDate: () => Date }).toDate().getTime()
    : new Date(String(value)).getTime();
}
function requestIdFor(threadId: string, state: Tier1State) {
  if (state.bookingRequestId) return state.bookingRequestId;
  return createHash("sha256")
    .update([providerId, locationId, threadId, state.serviceId, state.dateIso, state.time24h].join("|"))
    .digest("hex")
    .slice(0, 32);
}

export async function loadBookingContext(): Promise<BookingContext> {
  if (useSupabase) {
    if (!supabaseConfigured()) throw new Error("Supabase booking mode is enabled but its server credentials are missing");
    return loadSupabaseBookingContext({ providerId, locationId });
  }
  if (firestore) {
    const [servicesSnap, locationSettingsSnap, legacySettingsSnap] = await Promise.all([
      firestore.collection("services").where("location_id", "==", locationId).get(),
      firestore.collection("booking_settings").doc(locationId).get(),
      locationId === "washpoint-main" ? firestore.collection("booking_settings").doc("main").get() : Promise.resolve(null),
    ]);
    const settingsSnap = locationSettingsSnap.exists ? locationSettingsSnap : legacySettingsSnap;
    const s = settingsSnap?.data();
    const contextValue = {
      services: (servicesSnap.docs
        .map(item => ({ id: item.id, ...item.data() })) as Service[])
        .filter(item => inCurrentLocation(item) && (item as Service & { is_active?: boolean }).is_active !== false),
      settings: s ? {
        min_lead_minutes: Number(s.min_lead_minutes) || 60,
        max_advance_days: Number(s.max_advance_days) || 14,
        buffer_minutes: Number(s.buffer_minutes) || 15,
        weekday_open: s.weekday_open || "08:00", weekday_close: s.weekday_close || "19:00",
        weekend_open: s.weekend_open || "08:00", weekend_close: s.weekend_close || "21:00",
      } : fallback,
    };
    console.info("[tier1] firestore_context", { services: contextValue.services.length, weekday_close: contextValue.settings.weekday_close, min_lead_minutes: contextValue.settings.min_lead_minutes });
    return contextValue;
  }
  return { services: [], settings: fallback };
}

export async function availableSlots(contextValue: BookingContext, dateIso: string, service: Service, requestedTime?: string) {
  if (useSupabase) return availableSupabaseSlots(contextValue, { providerId, locationId }, dateIso, service, requestedTime);
  if (!firestore) return [];
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const latest = new Date(`${localDate()}T12:00:00+08:00`); latest.setUTCDate(latest.getUTCDate() + contextValue.settings.max_advance_days);
  // Do not compare a date's artificial noon timestamp with the current time:
  // that incorrectly removes the whole of today after noon. Individual slot
  // timestamps below enforce the minimum lead time instead.
  if (!isDateBookable(dateIso, localDate(), contextValue.settings.max_advance_days) || date > latest) return [];
  const weekend = [0, 6].includes(date.getUTCDay());
  const open = weekend ? contextValue.settings.weekend_open : contextValue.settings.weekday_open;
  const close = weekend ? contextValue.settings.weekend_close : contextValue.settings.weekday_close;
  let blackoutData: Array<TenantScoped & { date?: string }> = [];
  let baysData: Array<TenantScoped & { id: string; is_active?: boolean; status?: string }> = [];
  let appointmentsData: Array<TenantScoped & { bay_id: string; scheduled_at: unknown; duration_minutes: number; status?: string }> = [];
  let breaksData: Array<TenantScoped & { bay_id: string; start_time: string; duration_minutes: number }> = [];
  let closuresData: Array<TenantScoped & { bay_id: string; starts_at: unknown; ends_at: unknown }> = [];
  const [blackout, bays, appointments, breaks, closures] = await Promise.all([
    firestore.collection("blackout_dates").where("location_id", "==", locationId).get(),
    firestore.collection("bays").where("location_id", "==", locationId).get(),
    firestore.collection("appointments").where("location_id", "==", locationId).where("scheduled_date", "==", dateIso).get(),
    firestore.collection("crew_break_schedule").where("location_id", "==", locationId).get(),
    firestore.collection("bay_closures").where("location_id", "==", locationId).get(),
  ]);
  blackoutData = blackout.docs.map(x => x.data() as typeof blackoutData[number]).filter(x => x.date === dateIso && inCurrentLocation(x));
  baysData = (bays.docs.map(x => ({ id: x.id, ...x.data() })) as typeof baysData).filter(inCurrentLocation);
  appointmentsData = appointments.docs.map(x => x.data() as typeof appointmentsData[number]).filter(x => x.status !== "cancelled" && inCurrentLocation(x));
  breaksData = breaks.docs.map(x => x.data() as typeof breaksData[number]).filter(inCurrentLocation);
  closuresData = closures.docs.map(x => x.data() as typeof closuresData[number]).filter(inCurrentLocation);
  if (blackoutData.length || !baysData.length) return [];
  const starts = requestedTime ? [requestedTime] : Array.from({ length: Math.floor((mins(close) - mins(open)) / 30) + 1 }, (_, i) => mins(open) + i * 30).map(total => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  return starts.filter(time => {
    if (mins(time) < mins(open) || mins(time) + service.duration_minutes > mins(close)) return false;
    const start = new Date(`${dateIso}T${time}:00+08:00`).getTime(); const end = start + service.duration_minutes * 60000;
    if (start < Date.now() + contextValue.settings.min_lead_minutes * 60000) return false;
    return baysData.filter(bay => bay.is_active !== false && (!bay.status || bay.status === "open")).some(bay => {
      const busy = appointmentsData.some(a => {
        const existingStart = asMillis(a.scheduled_at);
        const existingEnd = existingStart + Number(a.duration_minutes) * 60000;
        return a.bay_id === bay.id && bookingIntervalsOverlap(start, end, existingStart, existingEnd, contextValue.settings.buffer_minutes);
      });
      const breakBusy = breaksData.some(b => b.bay_id === bay.id && intervalsOverlap(start, end, new Date(`${dateIso}T${String(b.start_time).slice(0, 5)}:00+08:00`).getTime(), new Date(`${dateIso}T${String(b.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(b.duration_minutes) * 60000));
      const closed = closuresData.some(c => c.bay_id === bay.id && intervalsOverlap(start, end, asMillis(c.starts_at), asMillis(c.ends_at)));
      return !busy && !breakBusy && !closed;
    });
  });
}

function menu(title: string, body: string, buttons: Array<{ id: string; label: string; value?: string }>) {
  const rows = Array.from({ length: Math.ceil(buttons.length / 3) }, (_, index) => buttons.slice(index * 3, index * 3 + 3));
  return Card({ title, children: [CardText(body), ...rows.map(row => Actions(row.map(button => Button({ id: button.id, label: button.label, value: button.value }))) )] });
}

export async function startTier1(thread: Thread) {
  const value: Tier1State = { step: "service", bookingRequestId: randomUUID(), lastActiveAt: new Date().toISOString() };
  await thread.setState(value);
  const c = await loadBookingContext();
  const services = c.services.slice(0, 8);
  await thread.post(menu("WashPoint — Book a wash", `Choose a service:\n${services.map(serviceLabel).join("\n")}`, services.map((s, index) => ({ id: "t1_service", label: s.name.replace(/\s+(Wash|Detail)$/i, "").slice(0, 12), value: String(index) }))));
}

export async function startTier1Channel(channel: Channel) {
  const c = await loadBookingContext();
  const services = c.services.slice(0, 8);
  await channel.post(menu("WashPoint — Book a wash", `Choose a service:\n${services.map(serviceLabel).join("\n")}`, services.map((s, index) => ({ id: "t1_service", label: s.name.replace(/\s+(Wash|Detail)$/i, "").slice(0, 12), value: String(index) }))));
}

export async function handleTier1Action(thread: Thread, actionId: string, value?: string) {
  const c = await loadBookingContext(); const state = ((await thread.state) as Tier1State | null) ?? { step: "service" };
  if (actionId === "t1_restart") return startTier1(thread);
  if (actionId === "t1_service" && value) {
    const s = c.services[Number(value)]; if (!s) return startTier1(thread);
    const dates = Array.from({ length: Math.min(c.settings.max_advance_days + 1, 14) }, (_, i) => addDays(localDate(), i));
    const usable = (await Promise.all(dates.map(async date => ({ date, slots: await availableSlots(c, date, s) })))).filter(x => x.slots.length);
    await thread.setState({ ...state, bookingRequestId: randomUUID(), step: "date", serviceId: s.id, serviceName: s.name, durationMinutes: s.duration_minutes, priceMyr: s.price_myr, lastActiveAt: new Date().toISOString() });
    return thread.post(menu(s.name, "Choose an available date:", usable.slice(0, 10).map(x => ({ id: "t1_date", label: formatShortDate(x.date), value: x.date }))));
  }
  if (actionId === "t1_date" && value && state.serviceId) {
    if (state.step !== "date") return thread.post("That date menu has expired. Please send /start to begin again.");
    const s = c.services.find(item => item.id === state.serviceId); if (!s) return startTier1(thread);
    const slots = await availableSlots(c, value, s); await thread.setState({ ...state, step: "time", dateIso: value, lastActiveAt: new Date().toISOString() });
    return thread.post(slots.length ? menu(formatDate(value), "Choose an available time:", slots.map(time => ({ id: "t1_time", label: time, value: time }))) : "That date has just filled up. Please send /start to choose another date.");
  }
  if (actionId === "t1_time" && value && state.serviceId && state.dateIso) {
    if (state.step !== "time") return thread.post("That time menu has expired. Please send /start to begin again.");
    const s = c.services.find(item => item.id === state.serviceId); if (!s || !(await availableSlots(c, state.dateIso, s, value)).includes(value)) return thread.post("That time is no longer available. Please send /start to choose again.");
    await thread.setState({ ...state, step: "name", time24h: value, lastActiveAt: new Date().toISOString() }); return thread.post("Please type your name.");
  }
  if (actionId === "t1_confirm") {
    if (state.step === "submitting") return;
    if (state.step === "completed") return thread.post("That booking has already been confirmed.");
    return confirmTier1(thread, c, state);
  }
  return thread.post("Please use the buttons above, or send /start to begin again.");
}

type ReservationResult =
  | { status: "created" | "existing"; reference: string; service: Service }
  | { status: "unavailable" };

export async function reserveFirestoreAppointment(threadId: string, state: Tier1State): Promise<ReservationResult> {
  if (!firestore || !state.serviceId || !state.dateIso || !state.time24h || !state.customerName || !state.customerPhone || !state.vehiclePlate || !state.vehicleMakeModel) {
    return { status: "unavailable" };
  }
  const db = firestore;
  const serviceId = state.serviceId;
  const dateIso = state.dateIso;
  const time24h = state.time24h;
  const customerName = state.customerName;
  const customerPhone = state.customerPhone;
  const requestId = requestIdFor(threadId, state);
  const idempotencyHash = createHash("sha256").update(requestId).digest("hex");
  const appointmentRef = db.collection("appointments").doc(`t1_${idempotencyHash.slice(0, 32)}`);
  const reference = `WP-T1-${dateIso.replaceAll("-", "")}-${idempotencyHash.slice(0, 6).toUpperCase()}`;

  return db.runTransaction(async transaction => {
    const existing = await transaction.get(appointmentRef);
    if (existing.exists) {
      const value = existing.data();
      if (value && inCurrentLocation(value)) {
        const serviceSnapshot = await transaction.get(db.collection("services").doc(value.service_id));
        if (serviceSnapshot.exists) {
          return {
            status: "existing" as const,
            reference: String(value.reference || reference),
            service: { id: serviceSnapshot.id, ...serviceSnapshot.data() } as Service,
          };
        }
      }
      return { status: "unavailable" as const };
    }

    const [serviceSnapshot, settingsSnapshot, baysSnapshot, bookingsSnapshot, blackoutSnapshot, breaksSnapshot, closuresSnapshot] = await Promise.all([
      transaction.get(db.collection("services").doc(serviceId)),
      transaction.get(db.collection("booking_settings").doc("main")),
      transaction.get(db.collection("bays")),
      transaction.get(db.collection("appointments").where("location_id", "==", locationId).where("scheduled_date", "==", dateIso)),
      transaction.get(db.collection("blackout_dates")),
      transaction.get(db.collection("crew_break_schedule")),
      transaction.get(db.collection("bay_closures")),
    ]);

    // Every confirmation for the same bay and calendar day reads and updates the
    // same lock document. If two customers confirm concurrently, Firestore
    // retries the losing transaction, which then sees the winner's appointment.
    const candidateBays = (baysSnapshot.docs.map(item => ({ id: item.id, ...item.data() })) as Array<TenantScoped & { id: string; is_active?: boolean; status?: string }>)
      .filter(inCurrentLocation)
      .filter(item => item.is_active !== false && (!item.status || item.status === "open"));
    const lockRefs = candidateBays.map(item => db.collection("booking_day_locks").doc(`${providerId}_${locationId}_${dateIso}_${item.id}`));
    const lockSnapshots = await Promise.all(lockRefs.map(ref => transaction.get(ref)));

    if (!serviceSnapshot.exists || !settingsSnapshot.exists) return { status: "unavailable" as const };
    const service = { id: serviceSnapshot.id, ...serviceSnapshot.data() } as Service & { is_active?: boolean };
    const settingsData = settingsSnapshot.data() as TenantScoped & Partial<Settings>;
    if (!inCurrentLocation(service) || service.is_active === false || !inCurrentLocation(settingsData)) {
      return { status: "unavailable" as const };
    }
    const settings: Settings = {
      min_lead_minutes: Number(settingsData.min_lead_minutes) || fallback.min_lead_minutes,
      max_advance_days: Number(settingsData.max_advance_days) || fallback.max_advance_days,
      buffer_minutes: Number(settingsData.buffer_minutes) || fallback.buffer_minutes,
      weekday_open: settingsData.weekday_open || fallback.weekday_open,
      weekday_close: settingsData.weekday_close || fallback.weekday_close,
      weekend_open: settingsData.weekend_open || fallback.weekend_open,
      weekend_close: settingsData.weekend_close || fallback.weekend_close,
    };

    const today = localDate();
    if (!isDateBookable(dateIso, today, settings.max_advance_days)) return { status: "unavailable" as const };
    const date = new Date(`${dateIso}T12:00:00+08:00`);
    const weekend = [0, 6].includes(date.getUTCDay());
    const open = weekend ? settings.weekend_open : settings.weekday_open;
    const close = weekend ? settings.weekend_close : settings.weekday_close;
    const start = new Date(`${dateIso}T${time24h}:00+08:00`).getTime();
    const end = start + Number(service.duration_minutes) * 60000;
    if (mins(time24h) < mins(open) || mins(time24h) + Number(service.duration_minutes) > mins(close)) return { status: "unavailable" as const };
    if (start < Date.now() + settings.min_lead_minutes * 60000) return { status: "unavailable" as const };
    if (blackoutSnapshot.docs.some(item => {
      const value = item.data();
      return inCurrentLocation(value) && value.date === dateIso;
    })) return { status: "unavailable" as const };

    const bookings = bookingsSnapshot.docs.map(item => item.data()).filter(value => inCurrentLocation(value) && value.status !== "cancelled");
    const breaks = breaksSnapshot.docs.map(item => item.data()).filter(inCurrentLocation);
    const closures = closuresSnapshot.docs.map(item => item.data()).filter(inCurrentLocation);
    const bay = candidateBays.find(item => {
        const bookingConflict = bookings.some(value => {
          if (value.bay_id !== item.id) return false;
          const existingStart = asMillis(value.scheduled_at);
          const existingEnd = existingStart + Number(value.duration_minutes) * 60000;
          return bookingIntervalsOverlap(start, end, existingStart, existingEnd, settings.buffer_minutes);
        });
        const breakConflict = breaks.some(value => {
          if (value.bay_id !== item.id) return false;
          const breakStart = new Date(`${dateIso}T${String(value.start_time).slice(0, 5)}:00+08:00`).getTime();
          return intervalsOverlap(start, end, breakStart, breakStart + Number(value.duration_minutes) * 60000);
        });
        const closureConflict = closures.some(value => value.bay_id === item.id && intervalsOverlap(start, end, asMillis(value.starts_at), asMillis(value.ends_at)));
        return !bookingConflict && !breakConflict && !closureConflict;
      });
    if (!bay) return { status: "unavailable" as const };

    const selectedLockIndex = candidateBays.findIndex(item => item.id === bay.id);
    const selectedLock = lockSnapshots[selectedLockIndex];
    transaction.set(lockRefs[selectedLockIndex], {
      provider_id: providerId,
      location_id: locationId,
      date: dateIso,
      bay_id: bay.id,
      revision: Number(selectedLock.data()?.revision || 0) + 1,
      updated_at: new Date().toISOString(),
    });
    transaction.create(appointmentRef, {
      provider_id: providerId,
      location_id: locationId,
      booking_request_id: requestId,
      customer_chat_id: threadId,
      customer_name: customerName,
      customer_phone: customerPhone,
      vehicle_plate: state.vehiclePlate,
      vehicle_make_model: state.vehicleMakeModel,
      channel: "telegram",
      bay_id: bay.id,
      service_id: service.id,
      scheduled_at: new Date(start).toISOString(),
      scheduled_date: dateIso,
      duration_minutes: Number(service.duration_minutes),
      price_myr: Number(service.price_myr),
      status: "confirmed",
      reference,
      created_at: new Date().toISOString(),
    });
    return { status: "created" as const, reference, service };
  });
}

async function confirmTier1(thread: Thread, c: BookingContext, state: Tier1State) {
  if ((!firestore && !useSupabase) || !state.serviceId || !state.dateIso || !state.time24h || !state.customerName || !state.customerPhone || !state.vehiclePlate || !state.vehicleMakeModel) return thread.post("I still need your name, phone number, car plate and car make/model before confirming.");
  await thread.setState({ ...state, step: "submitting", lastActiveAt: new Date().toISOString() });
  const reservation = useSupabase
    ? await reserveSupabaseAppointment(thread.id, state, { providerId, locationId })
    : await reserveFirestoreAppointment(thread.id, state);
  console.info("[tier1] transactional_confirmation", { providerId, locationId, date: state.dateIso, time: state.time24h, service: state.serviceId, status: reservation.status });
  if (reservation.status === "unavailable") {
    await thread.setState({ ...state, step: "confirm", lastActiveAt: new Date().toISOString() });
    return thread.post("That time is no longer available. Please send /start to choose another slot.");
  }
  await thread.setState({ ...state, step: "completed", lastActiveAt: new Date().toISOString() });
  return thread.post(`${reservation.status === "existing" ? "Already confirmed" : "Confirmed"} — ${reservation.service.name} on ${formatDate(state.dateIso)} at ${state.time24h}. Reference: ${reservation.reference}`);
}

export async function handleTier1Text(thread: Thread, text: string) {
  const state = ((await thread.state) as Tier1State | null) ?? { step: "service" };
  if (/^\/(start|restart|new)$/i.test(text.trim())) return startTier1(thread);
  if (state.step === "name") { await thread.setState({ ...state, step: "phone", customerName: text.trim(), lastActiveAt: new Date().toISOString() }); return thread.post("Please type your Malaysian mobile number, e.g. 012-3456789."); }
  if (state.step === "phone") { const value = phone(text); if (!value) return thread.post("That doesn't look like a Malaysian mobile number. Please send it again, e.g. 012-3456789."); await thread.setState({ ...state, step: "plate", customerPhone: value, lastActiveAt: new Date().toISOString() }); return thread.post("Please type your car plate number, e.g. ABC 1234."); }
  if (state.step === "plate") { const value = text.trim(); if (value.length < 2) return thread.post("Please send the car plate number, e.g. ABC 1234."); await thread.setState({ ...state, step: "vehicle", vehiclePlate: value, lastActiveAt: new Date().toISOString() }); return thread.post("Please type your car make and model, e.g. Perodua Myvi."); }
  if (state.step === "vehicle") { const value = text.trim(); if (value.length < 2) return thread.post("Please send the car make and model, e.g. Perodua Myvi."); const next = { ...state, step: "confirm" as const, vehicleMakeModel: value, lastActiveAt: new Date().toISOString() }; await thread.setState(next); return thread.post(menu("Review booking", `${state.serviceName}\n${formatDate(state.dateIso!)} at ${state.time24h}\n${state.customerName}\n${state.customerPhone}\n${state.vehiclePlate}\n${value}\nRM${state.priceMyr}`, [{ id: "t1_confirm", label: "Confirm", value: "yes" }, { id: "t1_restart", label: "Start over" }])); }
  if (state.step === "confirm") { if (isYes(text)) return confirmTier1(thread, await loadBookingContext(), state); if (isNo(text)) return startTier1(thread); return thread.post("Please reply Confirm or Start over."); }
  return thread.post("Please use the buttons above, or send /start to begin.");
}
