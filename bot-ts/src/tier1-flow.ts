import "./env.js";
import { createClient } from "@supabase/supabase-js";
import type { Thread } from "chat";
import { Actions, Button, Card, CardText } from "chat";

export type Tier1State = {
  step: "service" | "date" | "time" | "name" | "phone" | "confirm" | "completed";
  serviceId?: string;
  serviceName?: string;
  durationMinutes?: number;
  priceMyr?: number;
  dateIso?: string;
  time24h?: string;
  customerName?: string;
  customerPhone?: string;
  lastActiveAt?: string;
};

type Service = { id: string; name: string; duration_minutes: number; price_myr: number };
type Settings = { min_lead_minutes: number; max_advance_days: number; buffer_minutes: number; weekday_open: string; weekday_close: string; weekend_open: string; weekend_close: string };
type Context = { services: Service[]; settings: Settings };

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const fallback: Settings = { min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15, weekday_open: "08:00", weekday_close: "19:00", weekend_open: "08:00", weekend_close: "21:00" };

function localDate(date = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function addDays(dateIso: string, days: number) { const d = new Date(`${dateIso}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function mins(value: string) { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${value}T12:00:00+08:00`)); }
function serviceLabel(service: Service) { return `${service.name} — ${service.duration_minutes} min, RM${service.price_myr}`; }
function phone(value: string) { return value.match(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/)?.[0].replace(/[\s-]/g, ""); }
function isYes(value: string) { return /^(yes|y|confirm|confirmed|ya|betul|ok|okay)$/i.test(value.trim()); }
function isNo(value: string) { return /^(no|n|cancel|batal|restart|mula baru)$/i.test(value.trim()); }

async function context(): Promise<Context> {
  if (!supabase) return { services: [], settings: fallback };
  const [services, settings] = await Promise.all([
    supabase.from("services").select("id,name,duration_minutes,price_myr").eq("is_active", true).order("name"),
    supabase.from("booking_settings").select("min_lead_minutes,max_advance_days,buffer_minutes,weekday_open,weekday_close,weekend_open,weekend_close").eq("id", 1).maybeSingle(),
  ]);
  const s = settings.data;
  return { services: (services.data ?? []) as Service[], settings: s ? { min_lead_minutes: Number(s.min_lead_minutes) || 60, max_advance_days: Number(s.max_advance_days) || 14, buffer_minutes: Number(s.buffer_minutes) || 15, weekday_open: s.weekday_open || "08:00", weekday_close: s.weekday_close || "19:00", weekend_open: s.weekend_open || "08:00", weekend_close: s.weekend_close || "21:00" } : fallback };
}

async function available(contextValue: Context, dateIso: string, service: Service, requestedTime?: string) {
  if (!supabase) return [];
  const date = new Date(`${dateIso}T12:00:00+08:00`);
  const latest = new Date(`${localDate()}T12:00:00+08:00`); latest.setUTCDate(latest.getUTCDate() + contextValue.settings.max_advance_days);
  if (date > latest || date.getTime() < Date.now() + contextValue.settings.min_lead_minutes * 60000) return [];
  const weekend = [0, 6].includes(date.getUTCDay());
  const open = weekend ? contextValue.settings.weekend_open : contextValue.settings.weekday_open;
  const close = weekend ? contextValue.settings.weekend_close : contextValue.settings.weekday_close;
  const [blackout, bays, appointments, breaks, closures] = await Promise.all([
    supabase.from("blackout_dates").select("date").eq("date", dateIso),
    supabase.from("bays").select("id").eq("is_active", true).eq("status", "open"),
    supabase.from("appointments").select("bay_id,scheduled_at,duration_minutes").neq("status", "cancelled").gte("scheduled_at", `${dateIso}T00:00:00+08:00`).lt("scheduled_at", `${addDays(dateIso, 1)}T00:00:00+08:00`),
    supabase.from("crew_break_schedule").select("bay_id,start_time,duration_minutes"),
    supabase.from("bay_closures").select("bay_id,starts_at,ends_at").lt("starts_at", `${addDays(dateIso, 1)}T00:00:00+08:00`).gt("ends_at", `${dateIso}T00:00:00+08:00`),
  ]);
  if (blackout.data?.length || !bays.data?.length) return [];
  const starts = requestedTime ? [requestedTime] : Array.from({ length: Math.floor((mins(close) - mins(open)) / 30) + 1 }, (_, i) => mins(open) + i * 30).map(total => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`);
  const overlap = (a: number, b: number, c: number, d: number) => a < d && c < b;
  return starts.filter(time => {
    if (mins(time) < mins(open) || mins(time) + service.duration_minutes > mins(close)) return false;
    const start = new Date(`${dateIso}T${time}:00+08:00`).getTime(); const end = start + service.duration_minutes * 60000;
    if (start < Date.now() + contextValue.settings.min_lead_minutes * 60000) return false;
    return (bays.data ?? []).some(bay => {
      const busy = (appointments.data ?? []).some(a => a.bay_id === bay.id && overlap(start, end, new Date(a.scheduled_at).getTime(), new Date(a.scheduled_at).getTime() + Number(a.duration_minutes) * 60000 + contextValue.settings.buffer_minutes * 60000));
      const breakBusy = (breaks.data ?? []).some(b => b.bay_id === bay.id && overlap(start, end, new Date(`${dateIso}T${String(b.start_time).slice(0, 5)}:00+08:00`).getTime(), new Date(`${dateIso}T${String(b.start_time).slice(0, 5)}:00+08:00`).getTime() + Number(b.duration_minutes) * 60000));
      const closed = (closures.data ?? []).some(c => c.bay_id === bay.id && overlap(start, end, new Date(c.starts_at).getTime(), new Date(c.ends_at).getTime()));
      return !busy && !breakBusy && !closed;
    });
  });
}

function menu(title: string, body: string, buttons: Array<{ id: string; label: string; value?: string }>) {
  return Card({ title, children: [CardText(body), Actions(buttons.map(button => Button({ id: button.id, label: button.label, value: button.value })))] });
}

export async function startTier1(thread: Thread) {
  const value: Tier1State = { step: "service", lastActiveAt: new Date().toISOString() };
  await thread.setState(value);
  const c = await context();
  await thread.post(menu("WashPoint — Book a wash", "Choose a service:", c.services.slice(0, 8).map(s => ({ id: "t1_service", label: s.name, value: s.id }))));
}

export async function handleTier1Action(thread: Thread, actionId: string, value?: string) {
  const c = await context(); const state = ((await thread.state) as Tier1State | null) ?? { step: "service" };
  if (actionId === "t1_restart") return startTier1(thread);
  if (actionId === "t1_service" && value) {
    const s = c.services.find(item => item.id === value); if (!s) return startTier1(thread);
    const dates = Array.from({ length: Math.min(c.settings.max_advance_days + 1, 14) }, (_, i) => addDays(localDate(), i));
    const usable = (await Promise.all(dates.map(async date => ({ date, slots: await available(c, date, s) })))).filter(x => x.slots.length);
    await thread.setState({ ...state, step: "date", serviceId: s.id, serviceName: s.name, durationMinutes: s.duration_minutes, priceMyr: s.price_myr, lastActiveAt: new Date().toISOString() });
    return thread.post(menu(s.name, "Choose an available date:", usable.slice(0, 10).map(x => ({ id: "t1_date", label: formatDate(x.date), value: x.date }))));
  }
  if (actionId === "t1_date" && value && state.serviceId) {
    const s = c.services.find(item => item.id === state.serviceId); if (!s) return startTier1(thread);
    const slots = await available(c, value, s); await thread.setState({ ...state, step: "time", dateIso: value, lastActiveAt: new Date().toISOString() });
    return thread.post(slots.length ? menu(formatDate(value), "Choose an available time:", slots.map(time => ({ id: "t1_time", label: time, value: time }))) : "That date has just filled up. Please send /start to choose another date.");
  }
  if (actionId === "t1_time" && value && state.serviceId && state.dateIso) {
    const s = c.services.find(item => item.id === state.serviceId); if (!s || !(await available(c, state.dateIso, s, value)).includes(value)) return thread.post("That time is no longer available. Please send /start to choose again.");
    await thread.setState({ ...state, step: "name", time24h: value, lastActiveAt: new Date().toISOString() }); return thread.post("Please type your name.");
  }
  if (actionId === "t1_confirm") {
    return confirmTier1(thread, c, state);
  }
  return thread.post("Please use the buttons above, or send /start to begin again.");
}

async function confirmTier1(thread: Thread, c: Context, state: Tier1State) {
  if (!supabase || !state.serviceId || !state.dateIso || !state.time24h || !state.customerName || !state.customerPhone) return thread.post("I still need your name and Malaysian phone number before confirming.");
  const service = c.services.find(s => s.id === state.serviceId); if (!service || !(await available(c, state.dateIso, service, state.time24h)).includes(state.time24h)) return thread.post("That time is no longer available. Please send /start to choose another slot.");
  const bay = await supabase.from("bays").select("id").eq("is_active", true).eq("status", "open").limit(1).maybeSingle(); if (!bay.data) return thread.post("No bay is available right now. Please try another time.");
  const reference = `WP-T1-${state.dateIso.replaceAll("-", "")}-${Math.floor(1000 + Math.random() * 9000)}`;
  const result = await supabase.from("appointments").insert({ customer_chat_id: thread.id, customer_name: state.customerName, customer_phone: state.customerPhone, channel: "telegram-tier1", bay_id: bay.data.id, service_id: service.id, scheduled_at: new Date(`${state.dateIso}T${state.time24h}:00+08:00`).toISOString(), duration_minutes: service.duration_minutes, price_myr: service.price_myr, status: "confirmed", reference });
  if (result.error) return thread.post("I couldn't confirm that booking. Nothing was saved—please try again.");
  await thread.setState({ ...state, step: "completed", lastActiveAt: new Date().toISOString() }); return thread.post(`Confirmed — ${service.name} on ${formatDate(state.dateIso)} at ${state.time24h}. Reference: ${reference}`);
}

export async function handleTier1Text(thread: Thread, text: string) {
  const state = ((await thread.state) as Tier1State | null) ?? { step: "service" };
  if (/^\/(start|restart|new)$/i.test(text.trim())) return startTier1(thread);
  if (state.step === "name") { await thread.setState({ ...state, step: "phone", customerName: text.trim(), lastActiveAt: new Date().toISOString() }); return thread.post("Please type your Malaysian mobile number, e.g. 012-3456789."); }
  if (state.step === "phone") { const value = phone(text); if (!value) return thread.post("That doesn't look like a Malaysian mobile number. Please send it again, e.g. 012-3456789."); const next = { ...state, step: "confirm" as const, customerPhone: value, lastActiveAt: new Date().toISOString() }; await thread.setState(next); return thread.post(menu("Review booking", `${state.serviceName}\n${formatDate(state.dateIso!)} at ${state.time24h}\n${state.customerName}\n${value}\nRM${state.priceMyr}`, [{ id: "t1_confirm", label: "Confirm", value: "yes" }, { id: "t1_restart", label: "Start over" }])); }
  if (state.step === "confirm") { if (isYes(text)) return confirmTier1(thread, await context(), state); if (isNo(text)) return startTier1(thread); return thread.post("Please reply Confirm or Start over."); }
  return thread.post("Please use the buttons above, or send /start to begin.");
}
