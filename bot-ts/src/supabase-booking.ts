import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bookingIntervalsOverlap, intervalsOverlap, isDateBookable } from "./booking-rules.js";
import type { BookingContext, Service, Settings, Tier1State } from "./tier1-flow.js";

type Row = Record<string, unknown>;
type Tenant = { providerId: string; locationId: string };

const fallback: Settings = {
  min_lead_minutes: 60,
  max_advance_days: 14,
  buffer_minutes: 15,
  weekday_open: "08:00",
  weekday_close: "19:00",
  weekend_open: "08:00",
  weekend_close: "21:00",
};

function client(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase booking mode");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function publicSupabaseClient() { return client(); }

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function addDays(dateIso: string, days: number) { const d = new Date(`${dateIso}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function mins(value: string) { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; }
function asMillis(value: unknown) {
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function inTenant(row: Row, tenant: Tenant) { return row.provider_id === tenant.providerId && row.location_id === tenant.locationId; }
function settingsFrom(row?: Row): Settings {
  return {
    min_lead_minutes: Number(row?.min_lead_minutes) || fallback.min_lead_minutes,
    max_advance_days: Number(row?.max_advance_days) || fallback.max_advance_days,
    buffer_minutes: Number(row?.buffer_minutes) || fallback.buffer_minutes,
    weekday_open: String(row?.weekday_open || fallback.weekday_open).slice(0, 5),
    weekday_close: String(row?.weekday_close || fallback.weekday_close).slice(0, 5),
    weekend_open: String(row?.weekend_open || fallback.weekend_open).slice(0, 5),
    weekend_close: String(row?.weekend_close || fallback.weekend_close).slice(0, 5),
  };
}
function fail<T>(error: { message?: string } | null, operation: string): asserts error is null {
  if (error) throw new Error(`Supabase ${operation} failed: ${error.message || "unknown error"}`);
}

export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function loadSupabaseBookingContext(tenant: Tenant): Promise<BookingContext> {
  const db = client();
  const [{ data: services, error: servicesError }, { data: settings, error: settingsError }] = await Promise.all([
    db.from("services").select("id,name,duration_minutes,price_myr,is_active,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("is_active", true).order("name"),
    db.from("booking_settings").select("min_lead_minutes,max_advance_days,buffer_minutes,weekday_open,weekday_close,weekend_open,weekend_close,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).maybeSingle(),
  ]);
  fail(servicesError, "loading services");
  fail(settingsError, "loading booking settings");
  const context: BookingContext = {
    services: (services || []).map(row => ({ ...row, id: String(row.id), name: String(row.name), duration_minutes: Number(row.duration_minutes), price_myr: Number(row.price_myr) })) as Service[],
    settings: settingsFrom(settings || undefined),
  };
  console.info("[tier1] supabase_context", { services: context.services.length, weekday_close: context.settings.weekday_close, min_lead_minutes: context.settings.min_lead_minutes });
  return context;
}

export async function availableSupabaseSlots(context: BookingContext, tenant: Tenant, dateIso: string, service: Service, requestedTime?: string, excludeAppointmentId?: string) {
  const db = client();
  if (!isDateBookable(dateIso, localDate(), context.settings.max_advance_days)) return [];
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const weekend = [0, 6].includes(date.getUTCDay());
  const open = weekend ? context.settings.weekend_open : context.settings.weekday_open;
  const close = weekend ? context.settings.weekend_close : context.settings.weekday_close;
  const [blackoutResult, baysResult, appointmentsResult, breaksResult, closuresResult] = await Promise.all([
    db.from("blackout_dates").select("date,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("date", dateIso),
    db.from("bays").select("id,is_active,status,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("appointments").select("id,bay_id,scheduled_at,duration_minutes,status,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("scheduled_date", dateIso).neq("status", "cancelled"),
    db.from("crew_break_schedule").select("bay_id,start_time,duration_minutes,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("bay_closures").select("bay_id,starts_at,ends_at,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).lt("starts_at", `${dateIso}T23:59:59+08:00`).gt("ends_at", `${dateIso}T00:00:00+08:00`),
  ]);
  for (const [error, label] of [[blackoutResult.error, "loading blackout dates"], [baysResult.error, "loading bays"], [appointmentsResult.error, "loading appointments"], [breaksResult.error, "loading breaks"], [closuresResult.error, "loading bay closures"]] as const) fail(error, label);
  const bays = (baysResult.data || []).filter(row => row.is_active !== false && (!row.status || row.status === "open"));
  if (blackoutResult.data?.length || !bays.length) return [];
  const starts = requestedTime ? [requestedTime] : Array.from({ length: Math.floor((mins(close) - mins(open)) / 30) + 1 }, (_, i) => mins(open) + i * 30).map(total => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  return starts.filter(time => {
    if (mins(time) < mins(open) || mins(time) + service.duration_minutes > mins(close)) return false;
    const start = new Date(`${dateIso}T${time}:00+08:00`).getTime();
    const end = start + service.duration_minutes * 60000;
    if (start < Date.now() + context.settings.min_lead_minutes * 60000) return false;
    return bays.some(bay => {
      const busy = (appointmentsResult.data || []).some(row => row.id !== excludeAppointmentId && row.bay_id === bay.id && bookingIntervalsOverlap(start, end, asMillis(row.scheduled_at), asMillis(row.scheduled_at) + Number(row.duration_minutes) * 60000, context.settings.buffer_minutes));
      const breakBusy = (breaksResult.data || []).some(row => row.bay_id === bay.id && intervalsOverlap(start, end, new Date(`${dateIso}T${String(row.start_time).slice(0, 5)}:00+08:00`).getTime(), new Date(`${dateIso}T${String(row.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(row.duration_minutes) * 60000));
      const closureBusy = (closuresResult.data || []).some(row => row.bay_id === bay.id && intervalsOverlap(start, end, asMillis(row.starts_at), asMillis(row.ends_at)));
      return !busy && !breakBusy && !closureBusy;
    });
  });
}

export async function reserveSupabaseAppointment(threadId: string, state: Tier1State, tenant: Tenant): Promise<{ status: "created" | "existing"; reference: string; service: Service } | { status: "unavailable"; reference: string }> {
  if (!state.serviceId || !state.dateIso || !state.time24h || !state.customerName || !state.customerPhone) return { status: "unavailable", reference: "" };
  const db = client();
  const requestId = state.bookingRequestId || createHash("sha256").update([tenant.providerId, tenant.locationId, threadId, state.serviceId, state.dateIso, state.time24h].join("|")).digest("hex").slice(0, 32);
  const reference = `WP-T1-${state.dateIso.replaceAll("-", "")}-${requestId.slice(0, 6).toUpperCase()}`;
  const { data, error } = await db.rpc("reserve_appointment_atomic", {
    p_provider_id: tenant.providerId,
    p_location_id: tenant.locationId,
    p_booking_request_id: requestId,
    p_customer_chat_id: threadId,
    p_customer_name: state.customerName,
    p_customer_phone: state.customerPhone,
    p_channel: "telegram",
    p_service_id: state.serviceId,
    p_scheduled_date: state.dateIso,
    p_time: state.time24h,
    p_reference: reference,
  });
  fail(error, "reserving an appointment atomically");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.result_status === "unavailable") return { status: "unavailable", reference };
  if (!row.result_service_id || !row.result_service_name) throw new Error("Supabase atomic booking returned an incomplete service");
  const service: Service = {
    id: String(row.result_service_id),
    name: String(row.result_service_name),
    duration_minutes: Number(row.result_duration_minutes),
    price_myr: Number(row.result_price_myr),
  };
  return { status: row.result_status === "existing" ? "existing" : "created", reference: String(row.appointment_reference || reference), service };
}

function normalizePhone(value: string) { return value.replace(/[\s-]/g, "").replace(/^\+/, ""); }

async function publicBookingRow(reference: string, phone: string) {
  const db = client();
  const { data: appointment, error } = await db.from("appointments").select("*").eq("reference", reference.trim()).maybeSingle();
  fail(error, "finding booking");
  if (!appointment || normalizePhone(String(appointment.customer_phone || "")) !== normalizePhone(phone)) throw new Error("We could not find a booking with that reference and phone number.");
  return appointment;
}

async function publicBookingDetails(appointment: Row) {
  const db = client();
  const [{ data: service, error: serviceError }, { data: location, error: locationError }] = await Promise.all([
    db.from("services").select("id,name,duration_minutes,price_myr").eq("id", appointment.service_id).maybeSingle(),
    db.from("locations").select("id,name,address").eq("id", appointment.location_id).maybeSingle(),
  ]);
  fail(serviceError, "loading booking service"); fail(locationError, "loading booking location");
  return { reference: appointment.reference, status: appointment.status, customer_name: appointment.customer_name, customer_phone: appointment.customer_phone, provider_id: appointment.provider_id, location_id: appointment.location_id, bay_id: appointment.bay_id, scheduled_date: appointment.scheduled_date, scheduled_at: appointment.scheduled_at, duration_minutes: appointment.duration_minutes, price_myr: appointment.price_myr, service, location };
}

async function choosePublicBay(context: BookingContext, tenant: Tenant, appointment: Row, dateIso: string, time: string) {
  const db = client();
  const start = new Date(`${dateIso}T${time}:00+08:00`).getTime();
  const end = start + Number(appointment.duration_minutes) * 60000;
  const [baysResult, bookingsResult, breaksResult, closuresResult] = await Promise.all([
    db.from("bays").select("id,is_active,status").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("appointments").select("id,bay_id,scheduled_at,duration_minutes,status").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("scheduled_date", dateIso).neq("status", "cancelled"),
    db.from("crew_break_schedule").select("bay_id,start_time,duration_minutes").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("bay_closures").select("bay_id,starts_at,ends_at").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
  ]);
  fail(baysResult.error, "loading bays for booking change"); fail(bookingsResult.error, "loading bookings for booking change"); fail(breaksResult.error, "loading breaks for booking change"); fail(closuresResult.error, "loading closures for booking change");
  return (baysResult.data || []).filter(row => row.is_active !== false && (!row.status || row.status === "open")).find(bay => {
    const bookingBusy = (bookingsResult.data || []).some(item => item.id !== appointment.id && item.bay_id === bay.id && bookingIntervalsOverlap(start, end, asMillis(item.scheduled_at), asMillis(item.scheduled_at) + Number(item.duration_minutes) * 60000, context.settings.buffer_minutes));
    const breakBusy = (breaksResult.data || []).some(item => item.bay_id === bay.id && intervalsOverlap(start, end, new Date(`${dateIso}T${String(item.start_time).slice(0, 5)}:00+08:00`).getTime(), new Date(`${dateIso}T${String(item.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(item.duration_minutes) * 60000));
    const closureBusy = (closuresResult.data || []).some(item => item.bay_id === bay.id && intervalsOverlap(start, end, asMillis(item.starts_at), asMillis(item.ends_at)));
    return !bookingBusy && !breakBusy && !closureBusy;
  });
}

export async function managePublicBooking({ reference, phone, action, dateIso, time }: { reference: string; phone: string; action: "lookup" | "cancel" | "reschedule"; dateIso?: string; time?: string }) {
  const db = client();
  const appointment = await publicBookingRow(reference, phone);
  if (action === "lookup") return publicBookingDetails(appointment);
  if (appointment.status === "cancelled") throw new Error("This booking has already been cancelled.");
  const start = asMillis(appointment.scheduled_at);
  if (start <= Date.now() + 60 * 60000) throw new Error("This booking is too close to its appointment time to change online. Please contact the car wash.");
  if (action === "cancel") {
    const { data: updated, error } = await db.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", appointment.id).select().single();
    fail(error, "cancelling booking");
    const { error: eventError } = await db.from("booking_events").insert({ provider_id: appointment.provider_id, location_id: appointment.location_id, appointment_id: appointment.id, reference: appointment.reference, event_type: "status_changed", description: "Customer cancelled the booking online", old_value: { status: appointment.status }, new_value: { status: "cancelled" } });
    fail(eventError, "recording booking cancellation");
    return publicBookingDetails(updated);
  }
  if (!dateIso || !time || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("Choose a valid new date and time.");
  const context = await loadSupabaseBookingContext({ providerId: appointment.provider_id, locationId: appointment.location_id });
  const service = context.services.find(item => item.id === appointment.service_id);
  if (!service || !(await availableSupabaseSlots(context, { providerId: appointment.provider_id, locationId: appointment.location_id }, dateIso, service, time, appointment.id)).includes(time)) throw new Error("That time is no longer available.");
  const bay = await choosePublicBay(context, { providerId: appointment.provider_id, locationId: appointment.location_id }, appointment, dateIso, time);
  if (!bay) throw new Error("That time is no longer available.");
  const scheduledAt = new Date(`${dateIso}T${time}:00+08:00`).toISOString();
  const { data: updated, error } = await db.from("appointments").update({ scheduled_date: dateIso, scheduled_at: scheduledAt, bay_id: bay.id, updated_at: new Date().toISOString() }).eq("id", appointment.id).select().single();
  fail(error, "rescheduling booking");
  const { error: eventError } = await db.from("booking_events").insert({ provider_id: appointment.provider_id, location_id: appointment.location_id, appointment_id: appointment.id, reference: appointment.reference, event_type: "rescheduled", description: "Customer rescheduled the booking online", old_value: { scheduled_date: appointment.scheduled_date, scheduled_at: appointment.scheduled_at }, new_value: { scheduled_date: dateIso, scheduled_at: scheduledAt } });
  fail(eventError, "recording booking reschedule");
  return publicBookingDetails(updated);
}
