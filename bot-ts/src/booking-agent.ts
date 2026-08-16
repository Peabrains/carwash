import "./env.js";
import { createClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { bookingModel } from "./model.js";

export type SafeBookingState = {
  serviceName?: string;
  dateIso?: string;
  time24h?: string;
  hasCustomerName?: boolean;
  hasPhoneNumber?: boolean;
  lastActiveAt?: string;
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null;

function redactPhoneNumbers(text: string): string {
  return text.replace(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "[PHONE REDACTED]");
}

async function serviceSummary(): Promise<string> {
  if (!supabase) return "Service catalogue unavailable during this test.";
  const { data, error } = await supabase
    .from("services")
    .select("name,duration_minutes,price_myr")
    .eq("is_active", true)
    .order("name");
  if (error) return "Service catalogue unavailable during this test.";
  return (data ?? [])
    .map((service) => `${service.name}: ${service.duration_minutes} min, RM${service.price_myr}`)
    .join("; ");
}

export async function respondToCustomer(
  message: string,
  state: SafeBookingState | null,
): Promise<{ text: string; state: SafeBookingState }> {
  const safeMessage = redactPhoneNumbers(message);
  const services = await serviceSummary();
  const result = await generateText({
    model: bookingModel,
    system: `You are WashPoint, a Malaysian car-wash booking assistant.

Interpret customer intent from context. Understand Malay and Malaysian English/Manglish, including lusa, esok, petang, lepas kerja, and casual corrections. Preserve facts in the safe draft unless the customer changes them. Ask one focused question for the next missing booking detail.

Never claim a booking is confirmed. Never cancel, reschedule, or modify an existing booking. Never ask for information already represented by the safe draft. A separate application layer handles identity, availability, confirmations, and database writes.

Available services: ${services}
Safe draft (contains no raw name or phone): ${JSON.stringify(state ?? {})}`,
    prompt: safeMessage,
    providerOptions: {
      gateway: {
        disallowPromptTraining: true,
      } satisfies GatewayProviderOptions,
    },
    maxOutputTokens: 300,
  });

  return {
    text: result.text,
    state: { ...state, lastActiveAt: new Date().toISOString() },
  };
}
