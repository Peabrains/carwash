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
});

type Service = { name: string; duration_minutes: number; price_myr: number };
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
  const safeMessage = redactPhoneNumbers(message);
  const recentTurns = previous.recentTurns ?? [];

  const extracted = await generateObject({
    model: bookingModel,
    schema: extractionSchema,
    system: `You extract booking facts for a Malaysian car-wash assistant. Today in Malaysia is ${malaysiaToday()}.
Understand Malay, Manglish, shorthand, corrections, and replies such as "Full" or "the same time".
Return only facts explicitly stated or unambiguously implied by the current message.
Convert dates to YYYY-MM-DD and times to 24-hour HH:MM. For a date without a year, use the next occurrence on or after today.
Map service shorthand to the closest available service. Available services: ${serviceText(services)}.
Do not invent a name, date, time, or service. A phone number is detected locally and is not included in this prompt.`,
    prompt: `Recent conversation:\n${recentTurns.map((turn) => `${turn.role}: ${turn.content}`).join("\n") || "(none)"}\n\nCurrent customer message:\n${safeMessage}`,
    providerOptions: { gateway: { disallowPromptTraining: true } satisfies GatewayProviderOptions },
  });

  let merged: SafeBookingState = {
    ...previous,
    serviceName: canonicalService(extracted.object.serviceName, services) ?? previous.serviceName,
    dateIso: validDate(extracted.object.dateIso) ?? previous.dateIso,
    time24h: validTime(extracted.object.time24h) ?? previous.time24h,
    hasCustomerName: previous.hasCustomerName || extracted.object.hasCustomerName,
    hasPhoneNumber: previous.hasPhoneNumber || hasMalaysianPhoneNumber(message),
    status: "collecting_details",
    lastActiveAt: new Date().toISOString(),
  };

  if (extracted.object.intent === "restart") merged = { status: "collecting_details", lastActiveAt: new Date().toISOString() };

  const missing = missingDetail(merged);
  let text: string;
  if (extracted.object.intent === "cancel") {
    text = "I can help with that, but I won’t cancel anything without checking which confirmed booking you mean. Which booking would you like me to review?";
  } else if (extracted.object.intent === "reschedule") {
    text = "I can help review a reschedule, but I won’t change a confirmed booking without your confirmation. Which booking should I check?";
  } else if (missing) {
    const reply = await generateText({
      model: bookingModel,
      system: `You are WashPoint, a concise Malaysian car-wash booking assistant.
Respond naturally in the customer's language. The booking is not confirmed.
The application has already merged the customer's facts. Never ask for a field present in this draft.
Ask exactly one focused next question. Booking draft: ${JSON.stringify({ service: merged.serviceName, date: merged.dateIso, time: merged.time24h })}
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

  merged.recentTurns = [...recentTurns, { role: "user", content: safeMessage }, { role: "assistant", content: redactPhoneNumbers(text) }].slice(-8) as ConversationTurn[];
  return { text, state: merged };
}
