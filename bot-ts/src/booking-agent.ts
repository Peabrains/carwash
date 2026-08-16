import "./env.js";
import { createClient } from "@supabase/supabase-js";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { bookingModel } from "./model.js";

type ConversationTurn = { role: "user" | "assistant"; content: string };

export type SafeBookingState = {
  serviceName?: string;
  dateIso?: string;
  time24h?: string;
  hasCustomerName?: boolean;
  hasPhoneNumber?: boolean;
  language?: "en" | "ms";
  slotAvailable?: boolean;
  status?: "collecting_details" | "awaiting_confirmation" | "completed";
  recentTurns?: ConversationTurn[];
  lastActiveAt?: string;
};

const extractionSchema = z.object({
  intent: z.enum(["new_booking", "answer", "restart", "cancel", "reschedule", "other"]),
  serviceName: z.string().nullable(),
  dateIso: z.string().nullable(),
  time24h: z.string().nullable(),
  hasCustomerName: z.boolean(),
  customerLanguage: z.enum(["en", "ms"]),
});

type Service = { name: string; duration_minutes: number; price_myr: number };
type BookingSettings = {
  min_lead_minutes: number;
  max_advance_days: number;
  buffer_minutes: number;
  weekday_open: string;
  weekday_close: string;
  weekend_open: string;
  weekend_close: string;
};
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function redactPhoneNumbers(text: string): string {
  return text.replace(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "[PHONE REDACTED]");
}

function hasMalaysianPhoneNumber(text: string): boolean {
  return /(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(text);
}

async function loadServices(): Promise<Service[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("services").select("name,duration_minutes,price_myr").eq("is_active", true).order("name");
  return error ? [] : (data ?? []) as Service[];
}

async function loadBookingSettings(): Promise<BookingSettings> {
  const fallback = { min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15, weekday_open: "08:00", weekday_close: "19:00", weekend_open: "08:00", weekend_close: "21:00" };
  if (!supabase) return fallback;
  const { data, error } = await supabase
    .from("booking_settings")
    .select("min_lead_minutes,max_advance_days,buffer_minutes,weekday_open,weekday_close,weekend_open,weekend_close")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) {
    console.warn("[booking-agent] booking settings unavailable; using safe defaults", { error: error?.message });
    return fallback;
  }
  return {
    min_lead_minutes: Number(data.min_lead_minutes) || fallback.min_lead_minutes,
    max_advance_days: Number(data.max_advance_days) || fallback.max_advance_days,
    buffer_minutes: Number(data.buffer_minutes) || fallback.buffer_minutes,
    weekday_open: data.weekday_open || fallback.weekday_open,
    weekday_close: data.weekday_close || fallback.weekday_close,
    weekend_open: data.weekend_open || fallback.weekend_open,
    weekend_close: data.weekend_close || fallback.weekend_close,
  };
}

type Availability = { available: boolean; reason?: "closed" | "outside_hours" | "fully_booked" | "unavailable" };

function timeMinutes(value: string): number {
  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
}

async function checkAvailability(dateIso: string, time24h: string, service: Service, settings: BookingSettings): Promise<Availability> {
  if (!supabase) return { available: false, reason: "unavailable" };
  const requested = new Date(`${dateIso}T${time24h}:00+08:00`);
  // Use noon so the UTC conversion cannot move the date into the previous day.
  const day = new Date(`${dateIso}T12:00:00+08:00`).getUTCDay();
  const weekend = day === 0 || day === 6;
  const open = weekend ? settings.weekend_open : settings.weekday_open;
  const close = weekend ? settings.weekend_close : settings.weekday_close;
  const requestedMinutes = timeMinutes(time24h);
  if (requestedMinutes < timeMinutes(open) || requestedMinutes + service.duration_minutes > timeMinutes(close)) {
    return { available: false, reason: "outside_hours" };
  }

  const dayStart = `${dateIso}T00:00:00+08:00`;
  const dayEnd = `${dateIso}T23:59:59+08:00`;
  const [baysResult, appointmentsResult, breaksResult, closuresResult, blackoutResult] = await Promise.all([
    supabase.from("bays").select("id").eq("is_active", true).eq("status", "open"),
    supabase.from("appointments").select("bay_id,scheduled_at,duration_minutes").neq("status", "cancelled").gte("scheduled_at", dayStart).lte("scheduled_at", dayEnd),
    supabase.from("crew_break_schedule").select("bay_id,start_time,duration_minutes"),
    supabase.from("bay_closures").select("bay_id,starts_at,ends_at").lte("starts_at", dayEnd).gte("ends_at", dayStart),
    supabase.from("blackout_dates").select("label").eq("date", dateIso),
  ]);
  if ([baysResult, appointmentsResult, breaksResult, closuresResult, blackoutResult].some((result) => result.error)) {
    console.warn("[booking-agent] availability lookup failed", {
      errors: [baysResult, appointmentsResult, breaksResult, closuresResult, blackoutResult].map((result) => result.error?.message).filter(Boolean),
    });
    return { available: false, reason: "unavailable" };
  }
  if ((blackoutResult.data ?? []).length > 0) return { available: false, reason: "closed" };

  const requestedStart = requested.getTime();
  const requestedEnd = requestedStart + service.duration_minutes * 60_000;
  const buffer = settings.buffer_minutes * 60_000;
  const bays = (baysResult.data ?? []) as { id: string }[];
  const appointments = (appointmentsResult.data ?? []) as { bay_id: string; scheduled_at: string; duration_minutes: number }[];
  const breaks = (breaksResult.data ?? []) as { bay_id: string; start_time: string; duration_minutes: number }[];
  const closures = (closuresResult.data ?? []) as { bay_id: string; starts_at: string; ends_at: string }[];

  const hasOverlap = (start: number, end: number, otherStart: number, otherEnd: number) => start < otherEnd && otherStart < end;
  const freeBay = bays.some((bay) => {
    const appointmentConflict = appointments.some((appointment) => {
      if (appointment.bay_id !== bay.id) return false;
      const start = new Date(appointment.scheduled_at).getTime();
      return hasOverlap(requestedStart, requestedEnd, start, start + appointment.duration_minutes * 60_000 + buffer);
    });
    if (appointmentConflict) return false;
    const breakConflict = breaks.some((item) => {
      if (item.bay_id !== bay.id) return false;
      const start = new Date(`${dateIso}T${item.start_time.slice(0, 5)}:00+08:00`).getTime();
      return hasOverlap(requestedStart, requestedEnd, start, start + item.duration_minutes * 60_000);
    });
    if (breakConflict) return false;
    return !closures.some((closure) => closure.bay_id === bay.id && hasOverlap(requestedStart, requestedEnd, new Date(closure.starts_at).getTime(), new Date(closure.ends_at).getTime()));
  });
  return freeBay ? { available: true } : { available: false, reason: "fully_booked" };
}

function malaysiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function serviceText(services: Service[]): string {
  return services.length > 0 ? services.map((s) => `${s.name}: ${s.duration_minutes} min, RM${s.price_myr}`).join("; ") : "Service catalogue unavailable during this test.";
}

function canonicalService(value: string | null, services: Service[]): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const match = services.find((s) => {
    const candidate = s.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  });
  return match?.name;
}

function validDate(value: string | null): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function validTime(value: string | null): string | undefined {
  return value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

function dateAtMalaysiaMidnight(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00+08:00`);
}

function bookingDateError(dateIso: string, time24h: string, settings: BookingSettings): "too_early" | "too_far" | undefined {
  const requested = new Date(`${dateIso}T${time24h}:00+08:00`);
  if (Number.isNaN(requested.getTime())) return undefined;

  const now = new Date();
  if (requested.getTime() < now.getTime() + settings.min_lead_minutes * 60_000) return "too_early";

  const latestDate = dateAtMalaysiaMidnight(malaysiaToday());
  latestDate.setUTCDate(latestDate.getUTCDate() + settings.max_advance_days);
  if (dateAtMalaysiaMidnight(dateIso).getTime() > latestDate.getTime()) return "too_far";
  return undefined;
}

function bookingDateErrorText(error: "too_early" | "too_far", settings: BookingSettings, language: "en" | "ms"): string {
  const leadTime = settings.min_lead_minutes < 60
    ? `${settings.min_lead_minutes} minutes`
    : `${Math.round(settings.min_lead_minutes / 60)} hour${settings.min_lead_minutes === 60 ? "" : "s"}`;
  if (language === "ms") {
    return error === "too_far"
      ? `Maaf, kami hanya menerima tempahan sehingga ${settings.max_advance_days} hari lebih awal. Sila pilih tarikh yang lebih dekat.`
      : `Maaf, tempahan perlu dibuat sekurang-kurangnya ${leadTime} lebih awal. Sila pilih masa yang lebih lewat.`;
  }
  return error === "too_far"
    ? `Sorry, we only accept bookings up to ${settings.max_advance_days} days in advance. Please choose an earlier date.`
    : `Sorry, bookings must be made at least ${leadTime} in advance. Please choose a later time.`;
}

function missingDetail(state: SafeBookingState): "service" | "date" | "time" | "customer" | "phone" | null {
  if (!state.serviceName) return "service";
  if (!state.dateIso) return "date";
  if (!state.time24h) return "time";
  if (!state.hasCustomerName) return "customer";
  if (!state.hasPhoneNumber) return "phone";
  return null;
}

function questionFor(detail: ReturnType<typeof missingDetail>, services: Service[]): string {
  if (detail === "service") return `Which service would you like? ${serviceText(services)}`;
  if (detail === "date") return "What date would you like to book? You can say things like tomorrow, lusa, or 10 October.";
  if (detail === "time") return "What time would you prefer? Please include the time, such as 8am or 2:30pm.";
  if (detail === "customer") return "May I have the name for this booking?";
  if (detail === "phone") return "May I have a Malaysian mobile number for the booking?";
  return "";
}

export async function respondToCustomer(message: string, state: SafeBookingState | null): Promise<{ text: string; state: SafeBookingState }> {
  const previous = state ?? {};
  const services = await loadServices();
  const settings = await loadBookingSettings();
  const safeMessage = redactPhoneNumbers(message);
  const recentTurns = previous.recentTurns ?? [];
  const customerHistory = recentTurns.filter((turn) => turn.role === "user");

  const extracted = await generateObject({
    model: bookingModel,
    schema: extractionSchema,
    system: `You extract booking facts for a Malaysian car-wash assistant. Today in Malaysia is ${malaysiaToday()}.
Understand Malay, Manglish, shorthand, corrections, and replies such as "Full" or "the same time".
Return only facts explicitly stated or unambiguously implied by the current message.
Convert dates to YYYY-MM-DD and times to 24-hour HH:MM. For a date without a year, use the next occurrence on or after today.
Map service shorthand to the closest available service. Available services: ${serviceText(services)}.
Current booking rules from the live settings: bookings require at least ${settings.min_lead_minutes} minutes' notice and can be made up to ${settings.max_advance_days} days ahead. These rules are authoritative; do not tell the customer a date is bookable if it violates them.
Classify the customer's language from the current customer message and previous customer messages only. Use "ms" for clearly Malay/Manglish messages; otherwise use "en". Never infer language from an assistant message.
Do not invent a name, date, time, or service. A phone number is detected locally and is not included in this prompt.`,
    prompt: `Previous customer messages:\n${customerHistory.map((turn) => turn.content).join("\n") || "(none)"}\n\nCurrent customer message:\n${safeMessage}`,
    providerOptions: { gateway: { disallowPromptTraining: true } satisfies GatewayProviderOptions },
  });

  let merged: SafeBookingState = {
    ...previous,
    serviceName: canonicalService(extracted.object.serviceName, services) ?? previous.serviceName,
    dateIso: validDate(extracted.object.dateIso) ?? previous.dateIso,
    time24h: validTime(extracted.object.time24h) ?? previous.time24h,
    hasCustomerName: previous.hasCustomerName || extracted.object.hasCustomerName,
    hasPhoneNumber: previous.hasPhoneNumber || hasMalaysianPhoneNumber(message),
    language: extracted.object.customerLanguage || previous.language || "en",
    status: "collecting_details",
    lastActiveAt: new Date().toISOString(),
  };

  if (extracted.object.intent === "restart") merged = { status: "collecting_details", lastActiveAt: new Date().toISOString() };

  const missing = missingDetail(merged);
  const dateError = merged.dateIso && merged.time24h
    ? bookingDateError(merged.dateIso, merged.time24h, settings)
    : undefined;
  let text: string;
  if (extracted.object.intent === "cancel") {
    text = "I can help with that, but I won’t cancel anything without checking which confirmed booking you mean. Which booking would you like me to review?";
  } else if (extracted.object.intent === "reschedule") {
    text = "I can help review a reschedule, but I won’t change a confirmed booking without your confirmation. Which booking should I check?";
  } else if (dateError) {
    merged.dateIso = undefined;
    merged.time24h = undefined;
    merged.status = "collecting_details";
    text = bookingDateErrorText(dateError, settings, merged.language ?? "en");
  } else if (merged.serviceName && merged.dateIso && merged.time24h) {
    const service = services.find((item) => item.name === merged.serviceName);
    const availability = service ? await checkAvailability(merged.dateIso, merged.time24h, service, settings) : { available: false, reason: "unavailable" as const };
    merged.slotAvailable = availability.available;
    if (!availability.available) {
      const unavailableText = merged.language === "ms"
        ? availability.reason === "outside_hours" ? "Masa itu di luar waktu operasi kami. Sila pilih masa lain." : availability.reason === "closed" ? "Maaf, kami tutup pada tarikh itu. Sila pilih tarikh lain." : availability.reason === "fully_booked" ? "Maaf, slot itu sudah penuh. Sila pilih masa atau tarikh lain." : "Maaf, saya tidak dapat menyemak ketersediaan sekarang. Sila cuba sebentar lagi."
        : availability.reason === "outside_hours" ? "That time is outside our operating hours. Please choose another time." : availability.reason === "closed" ? "Sorry, we are closed on that date. Please choose another date." : availability.reason === "fully_booked" ? "Sorry, that slot is fully booked. Please choose another time or date." : "Sorry, I could not check availability right now. Please try again shortly.";
      text = unavailableText;
    } else if (missing) {
      const reply = await generateText({
        model: bookingModel,
        system: `You are WashPoint, a concise Malaysian car-wash booking assistant.
Use English by default. Use Malay/Manglish only when the customer's messages are clearly Malay/Manglish. Never switch language because an assistant message used Malay.
The requested slot has been confirmed available. The booking is not confirmed.
The application has already merged the customer's facts. Never ask for a field present in this draft.
Ask exactly one focused next question. Booking draft: ${JSON.stringify({ service: merged.serviceName, date: merged.dateIso, time: merged.time24h })}
Current customer language: ${merged.language === "ms" ? "Malay/Manglish" : "English"}.
Fallback next question: ${questionFor(missing, services)}`,
        prompt: safeMessage,
        providerOptions: { gateway: { disallowPromptTraining: true } satisfies GatewayProviderOptions },
        maxOutputTokens: 220,
      });
      text = reply.text || questionFor(missing, services);
    } else {
      text = `Good news — ${merged.serviceName} on ${merged.dateIso} at ${merged.time24h} is available. Shall I proceed? Please reply yes or no.`;
    }
  } else if (missing) {
    const reply = await generateText({
      model: bookingModel,
      system: `You are WashPoint, a concise Malaysian car-wash booking assistant.
Use English by default. Use Malay/Manglish only when the customer's messages are clearly Malay/Manglish. Never switch language because an assistant message used Malay.
The booking is not confirmed.
The application has already merged the customer's facts. Never ask for a field present in this draft.
Ask exactly one focused next question. Booking draft: ${JSON.stringify({ service: merged.serviceName, date: merged.dateIso, time: merged.time24h })}
Live booking rules: minimum notice ${settings.min_lead_minutes} minutes; maximum advance ${settings.max_advance_days} days.
Current customer language: ${merged.language === "ms" ? "Malay/Manglish" : "English"}.
Fallback next question: ${questionFor(missing, services)}`,
      prompt: safeMessage,
      providerOptions: { gateway: { disallowPromptTraining: true } satisfies GatewayProviderOptions },
      maxOutputTokens: 220,
    });
    text = reply.text || questionFor(missing, services);
  } else {
    merged.status = "awaiting_confirmation";
    text = `I have the booking details as ${merged.serviceName} on ${merged.dateIso} at ${merged.time24h}. Shall I proceed with this booking? Please reply yes or no.`;
  }

  console.info("[booking-agent] decision", {
    intent: extracted.object.intent,
    language: merged.language ?? "en",
    service: merged.serviceName,
    date: merged.dateIso,
    time: merged.time24h,
    missing: missingDetail(merged),
    dateError,
    status: merged.status,
  });

  merged.recentTurns = [...recentTurns, { role: "user", content: safeMessage }, { role: "assistant", content: redactPhoneNumbers(text) }].slice(-8) as ConversationTurn[];
  return { text, state: merged };
}
