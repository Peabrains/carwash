import "./env.js";
import { randomUUID } from "node:crypto";
import type { Channel, Thread } from "chat";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Actions, Button, Card, CardText } from "chat";
import { availableSupabaseSlots, loadSupabaseBookingContext, publicSupabaseClient, reserveSupabaseAppointment } from "./supabase-booking.js";
import { listMarketplaceProviders } from "./public-provider-access.js";

export type Tier1State = {
  step: "provider" | "location" | "service" | "date" | "time" | "name" | "phone" | "plate" | "vehicle" | "confirm" | "submitting" | "completed";
  providerId?: string;
  providerName?: string;
  locationId?: string;
  locationName?: string;
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

const useSupabase = true;

function localDate(date = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function addDays(dateIso: string, days: number) { const d = new Date(`${dateIso}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function mins(value: string) { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00+08:00`)); }
function formatShortDate(value: string) { return new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric" }).format(new Date(`${value}T12:00:00+08:00`)); }
function serviceLabel(service: Service) { return `${service.name} — ${service.duration_minutes} min, RM${service.price_myr}`; }
function phone(value: string) { return value.match(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/)?.[0].replace(/[\s-]/g, ""); }
function isYes(value: string) { return /^(yes|y|confirm|confirmed|ya|betul|ok|okay)$/i.test(value.trim()); }
function isNo(value: string) { return /^(no|n|cancel|batal|restart|mula baru)$/i.test(value.trim()); }
type Provider = { id: string; name: string };
type Location = { id: string; name: string; provider_id: string };

export async function activeProviders(db: SupabaseClient = publicSupabaseClient()): Promise<Provider[]> {
  return listMarketplaceProviders(db);
}

async function activeLocations(providerId: string): Promise<Location[]> {
  const { data, error } = await publicSupabaseClient().from("locations").select("id,name,provider_id").eq("provider_id", providerId).eq("is_active", true).order("name");
  if (error) throw new Error(`Supabase loading locations failed: ${error.message}`);
  return (data || []).map(row => ({ id: String(row.id), name: String(row.name), provider_id: String(row.provider_id) }));
}

function tenant(state: Tier1State) {
  if (!state.providerId || !state.locationId) throw new Error("Provider and location selection is required");
  return { providerId: state.providerId, locationId: state.locationId };
}

async function showProviders(target: Thread | Channel) {
  const providers = await activeProviders();
  return target.post(menu("WashCar — Book a wash", "Which provider would you like to book with?", providers.slice(0, 8).map(provider => ({ id: "t1_provider", label: provider.name.slice(0, 20), value: provider.id }))));
}

async function showServices(thread: Thread, state: Tier1State) {
  const c = await loadSupabaseBookingContext(tenant(state));
  const services = c.services.slice(0, 8);
  return thread.post(menu(`${state.providerName || "Provider"} — Book a wash`, `Choose a service at ${state.locationName || "the selected location"}:\n${services.map(serviceLabel).join("\n")}`, services.map((s, index) => ({ id: "t1_service", label: s.name.replace(/\s+(Wash|Detail)$/i, "").slice(0, 12), value: String(index) }))));
}

function menu(title: string, body: string, buttons: Array<{ id: string; label: string; value?: string }>) {
  const rows = Array.from({ length: Math.ceil(buttons.length / 3) }, (_, index) => buttons.slice(index * 3, index * 3 + 3));
  return Card({ title, children: [CardText(body), ...rows.map(row => Actions(row.map(button => Button({ id: button.id, label: button.label, value: button.value }))) )] });
}

export async function startTier1(thread: Thread) {
  const value: Tier1State = { step: "provider", bookingRequestId: randomUUID(), lastActiveAt: new Date().toISOString() };
  await thread.setState(value);
  await showProviders(thread);
}

export async function startTier1Channel(channel: Channel) {
  await showProviders(channel);
}

export async function handleTier1Action(thread: Thread, actionId: string, value?: string) {
  const state = ((await thread.state) as Tier1State | null) ?? { step: "provider" as const };
  if (actionId === "t1_restart") return startTier1(thread);
  if (actionId === "t1_provider" && value) {
    const provider = (await activeProviders()).find(item => item.id === value);
    if (!provider) return startTier1(thread);
    const locations = await activeLocations(provider.id);
    const next = { ...state, providerId: provider.id, providerName: provider.name, step: locations.length === 1 ? "service" as const : "location" as const, locationId: locations.length === 1 ? locations[0].id : undefined, locationName: locations.length === 1 ? locations[0].name : undefined, lastActiveAt: new Date().toISOString() };
    await thread.setState(next);
    if (locations.length === 1) return showServices(thread, next);
    return thread.post(menu(`${provider.name} — Choose a location`, "Which location would you like to visit?", locations.slice(0, 8).map(location => ({ id: "t1_location", label: location.name.slice(0, 20), value: location.id }))));
  }
  if (actionId === "t1_location" && value && state.providerId) {
    const location = (await activeLocations(state.providerId)).find(item => item.id === value);
    if (!location) return startTier1(thread);
    const next = { ...state, locationId: location.id, locationName: location.name, step: "service" as const, lastActiveAt: new Date().toISOString() };
    await thread.setState(next);
    return showServices(thread, next);
  }
  if (!state.providerId || !state.locationId) return startTier1(thread);
  const c = await loadSupabaseBookingContext(tenant(state));
  if (actionId === "t1_service" && value) {
    const s = c.services[Number(value)]; if (!s) return startTier1(thread);
    const dates = Array.from({ length: Math.min(c.settings.max_advance_days + 1, 14) }, (_, i) => addDays(localDate(), i));
    const usable = (await Promise.all(dates.map(async date => ({ date, slots: await availableSupabaseSlots(c, tenant(state), date, s) })))).filter(x => x.slots.length);
    await thread.setState({ ...state, bookingRequestId: randomUUID(), step: "date", serviceId: s.id, serviceName: s.name, durationMinutes: s.duration_minutes, priceMyr: s.price_myr, lastActiveAt: new Date().toISOString() });
    return thread.post(menu(s.name, "Choose an available date:", usable.slice(0, 10).map(x => ({ id: "t1_date", label: formatShortDate(x.date), value: x.date }))));
  }
  if (actionId === "t1_date" && value && state.serviceId) {
    if (state.step !== "date") return thread.post("That date menu has expired. Please send /start to begin again.");
    const s = c.services.find(item => item.id === state.serviceId); if (!s) return startTier1(thread);
    const slots = await availableSupabaseSlots(c, tenant(state), value, s); await thread.setState({ ...state, step: "time", dateIso: value, lastActiveAt: new Date().toISOString() });
    return thread.post(slots.length ? menu(formatDate(value), "Choose an available time:", slots.map(time => ({ id: "t1_time", label: time, value: time }))) : "That date has just filled up. Please send /start to choose another date.");
  }
  if (actionId === "t1_time" && value && state.serviceId && state.dateIso) {
    if (state.step !== "time") return thread.post("That time menu has expired. Please send /start to begin again.");
    const s = c.services.find(item => item.id === state.serviceId); if (!s || !(await availableSupabaseSlots(c, tenant(state), state.dateIso, s, value)).includes(value)) return thread.post("That time is no longer available. Please send /start to choose again.");
    await thread.setState({ ...state, step: "name", time24h: value, lastActiveAt: new Date().toISOString() }); return thread.post("Please type your name.");
  }
  if (actionId === "t1_confirm") {
    if (state.step === "submitting") return;
    if (state.step === "completed") return thread.post("That booking has already been confirmed.");
    return confirmTier1(thread, c, state);
  }
  return thread.post("Please use the buttons above, or send /start to begin again.");
}

async function confirmTier1(thread: Thread, c: BookingContext, state: Tier1State) {
  if ((!useSupabase) || !state.serviceId || !state.dateIso || !state.time24h || !state.customerName || !state.customerPhone || !state.vehiclePlate || !state.vehicleMakeModel) return thread.post("I still need your name, phone number, car plate and car make/model before confirming.");
  await thread.setState({ ...state, step: "submitting", lastActiveAt: new Date().toISOString() });
  const reservation = useSupabase
    ? await reserveSupabaseAppointment(thread.id, state, tenant(state))
    : { status: "unavailable" as const };
  console.info("[tier1] transactional_confirmation", { providerId: state.providerId, locationId: state.locationId, date: state.dateIso, time: state.time24h, service: state.serviceId, status: reservation.status });
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
  if (state.step === "confirm") { if (isYes(text)) return confirmTier1(thread, await loadSupabaseBookingContext(tenant(state)), state); if (isNo(text)) return startTier1(thread); return thread.post("Please reply Confirm or Start over."); }
  return thread.post("Please use the buttons above, or send /start to begin.");
}
