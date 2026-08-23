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

export async function availableSupabaseSlots(context: BookingContext, tenant: Tenant, dateIso: string, service: Service, requestedTime?: string) {
  const db = client();
  if (!isDateBookable(dateIso, localDate(), context.settings.max_advance_days)) return [];
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const weekend = [0, 6].includes(date.getUTCDay());
  const open = weekend ? context.settings.weekend_open : context.settings.weekday_open;
  const close = weekend ? context.settings.weekend_close : context.settings.weekday_close;
  const [blackoutResult, baysResult, appointmentsResult, breaksResult, closuresResult] = await Promise.all([
    db.from("blackout_dates").select("date,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("date", dateIso),
    db.from("bays").select("id,is_active,status,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("appointments").select("bay_id,scheduled_at,duration_minutes,status,provider_id,location_id").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("scheduled_date", dateIso).neq("status", "cancelled"),
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
      const busy = (appointmentsResult.data || []).some(row => row.bay_id === bay.id && bookingIntervalsOverlap(start, end, asMillis(row.scheduled_at), asMillis(row.scheduled_at) + Number(row.duration_minutes) * 60000, context.settings.buffer_minutes));
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
  const { data: existing, error: existingError } = await db.from("appointments").select("reference,service_id,status").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("booking_request_id", requestId).maybeSingle();
  fail(existingError, "checking an existing booking");
  if (existing) {
    const { data: service, error } = await db.from("services").select("id,name,duration_minutes,price_myr,provider_id,location_id").eq("id", existing.service_id).single();
    fail(error, "loading the existing service");
    return { status: "existing", reference: String(existing.reference || reference), service: service as Service };
  }
  const context = await loadSupabaseBookingContext(tenant);
  const service = context.services.find(item => item.id === state.serviceId);
  if (!service || !(await availableSupabaseSlots(context, tenant, state.dateIso, service, state.time24h)).includes(state.time24h)) return { status: "unavailable", reference };
  const [baysResult, bookingsResult, breaksResult, closuresResult] = await Promise.all([
    db.from("bays").select("id,is_active,status").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("appointments").select("bay_id,scheduled_at,duration_minutes,status").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("scheduled_date", state.dateIso).neq("status", "cancelled"),
    db.from("crew_break_schedule").select("bay_id,start_time,duration_minutes").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
    db.from("bay_closures").select("bay_id,starts_at,ends_at").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId),
  ]);
  fail(baysResult.error, "loading bays for confirmation"); fail(bookingsResult.error, "loading bookings for confirmation"); fail(breaksResult.error, "loading breaks for confirmation"); fail(closuresResult.error, "loading closures for confirmation");
  const start = new Date(`${state.dateIso}T${state.time24h}:00+08:00`).getTime(); const end = start + service.duration_minutes * 60000;
  const bay = (baysResult.data || []).filter(row => row.is_active !== false && (!row.status || row.status === "open")).find(row => {
    const bookingBusy = (bookingsResult.data || []).some(item => item.bay_id === row.id && bookingIntervalsOverlap(start, end, asMillis(item.scheduled_at), asMillis(item.scheduled_at) + Number(item.duration_minutes) * 60000, context.settings.buffer_minutes));
    const breakBusy = (breaksResult.data || []).some(item => item.bay_id === row.id && intervalsOverlap(start, end, new Date(`${state.dateIso}T${String(item.start_time).slice(0, 5)}:00+08:00`).getTime(), new Date(`${state.dateIso}T${String(item.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(item.duration_minutes) * 60000));
    const closureBusy = (closuresResult.data || []).some(item => item.bay_id === row.id && intervalsOverlap(start, end, asMillis(item.starts_at), asMillis(item.ends_at)));
    return !bookingBusy && !breakBusy && !closureBusy;
  });
  if (!bay) return { status: "unavailable", reference };
  const { error: insertError } = await db.from("appointments").insert({ provider_id: tenant.providerId, location_id: tenant.locationId, booking_request_id: requestId, customer_chat_id: threadId, customer_name: state.customerName, customer_phone: state.customerPhone, channel: "telegram", bay_id: bay.id, service_id: service.id, scheduled_at: new Date(start).toISOString(), scheduled_date: state.dateIso, duration_minutes: service.duration_minutes, price_myr: service.price_myr, status: "confirmed", reference });
  if (insertError) {
    const duplicate = await db.from("appointments").select("reference").eq("provider_id", tenant.providerId).eq("location_id", tenant.locationId).eq("booking_request_id", requestId).maybeSingle();
    if (!duplicate.error && duplicate.data) return { status: "existing", reference: String(duplicate.data.reference || reference), service };
    throw new Error(`Supabase booking insert failed: ${insertError.message}`);
  }
  return { status: "created", reference, service };
}
