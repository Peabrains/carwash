import "./env.js";
import { randomUUID } from "node:crypto";
import { generateObject } from "ai";
import { z } from "zod";
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { bookingModel } from "./model.js";
import { availableSlots, loadBookingContext, type BookingContext, type Service, type Settings } from "./tier1-flow.js";
import { reserveSupabaseAppointment } from "./supabase-booking.js";

type Turn = { role: "user" | "assistant"; content: string };
export type SafeBookingState = {
  serviceName?: string; dateIso?: string; time24h?: string;
  customerName?: string; customerPhone?: string; vehiclePlate?: string; vehicleMakeModel?: string; language?: "en" | "ms";
  status?: "collecting" | "awaiting_confirmation" | "paused" | "completed";
  recentTurns?: Turn[]; lastActiveAt?: string; bookingRequestId?: string;
};
type Availability = { available: boolean; bayId?: string; reason: string };
const schema = z.object({ reply: z.string(), intent: z.enum(["new_booking","answer","restart","cancel","reschedule","other"]), language: z.enum(["en","ms"]), serviceName: z.string().nullable(), dateIso: z.string().nullable(), time24h: z.string().nullable(), customerName: z.string().nullable(), vehiclePlate: z.string().nullable(), vehicleMakeModel: z.string().nullable(), handoff: z.boolean() });
function redact(text: string) { return text.replace(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "[PHONE REDACTED]"); }
function findPhone(text: string) { const m = text.match(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/); return m && m[0].replace(/[\s-]/g, ""); }
function todayMalaysia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function serviceFor(name: string | null | undefined, services: Service[]) { if (!name) return undefined; const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return services.find(s => { const c = s.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return c === n || c.includes(n) || n.includes(c); }); }
function validDate(v?: string | null) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined; }
function validTime(v?: string | null) { return v && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined; }
function mins(v: string) { const p = v.slice(0,5).split(":").map(Number); return p[0] * 60 + p[1]; }

async function loadContext(): Promise<BookingContext> { return loadBookingContext(); }
async function checkAvailability(dateIso: string, time: string, service: Service, settings: Settings): Promise<Availability> {
  const latest = new Date(todayMalaysia() + "T12:00:00+08:00");
  latest.setUTCDate(latest.getUTCDate() + settings.max_advance_days);
  if (new Date(dateIso + "T12:00:00+08:00").getTime() > latest.getTime()) return { available: false, reason: "too_far" };
  const requested = new Date(dateIso + "T" + time + ":00+08:00");
  const day = new Date(dateIso + "T12:00:00+08:00").getUTCDay();
  const open = day === 0 || day === 6 ? settings.weekend_open : settings.weekday_open;
  const close = day === 0 || day === 6 ? settings.weekend_close : settings.weekday_close;
  if (mins(time) < mins(open) || mins(time) + service.duration_minutes > mins(close)) return { available:false, reason:"outside_hours" };
  if (requested.getTime() < Date.now() + settings.min_lead_minutes * 60000) return { available:false, reason:"too_soon" };
  const slots = await availableSlots({ services: [service], settings }, dateIso, service, time);
  return slots.includes(time) ? { available: true, reason: "available" } : { available: false, reason: "fully_booked" };
}

async function submitBooking(state: SafeBookingState, context: BookingContext, chatId: string): Promise<string> {
  if(!state.serviceName||!state.dateIso||!state.time24h||!state.customerName||!state.customerPhone||!state.vehiclePlate||!state.vehicleMakeModel)return "I still need the complete booking details, including car plate and make/model, before submitting.";
  const service=serviceFor(state.serviceName,context.services); if(!service)return "I couldn't match that service to the live catalogue.";
  const bookingState = { step: "confirm" as const, bookingRequestId: state.bookingRequestId, serviceId: service.id, serviceName: service.name, durationMinutes: service.duration_minutes, priceMyr: service.price_myr, dateIso: state.dateIso, time24h: state.time24h, customerName: state.customerName, customerPhone: state.customerPhone, vehiclePlate: state.vehiclePlate, vehicleMakeModel: state.vehicleMakeModel };
  const result = await reserveSupabaseAppointment(chatId, bookingState, { providerId: process.env.TIER1_PROVIDER_ID || "washpoint", locationId: process.env.TIER1_LOCATION_ID || "washpoint-main" });
  if(result.status === "unavailable") return "That slot is no longer available. Please choose another time.";
  return (result.status === "existing" ? "Already confirmed — " : "Confirmed — ")+service.name+" on "+state.dateIso+" at "+state.time24h+". Your reference is "+result.reference+".";
}

export async function respondToCustomer(message: string, previous: SafeBookingState | null, chatId = "unknown"): Promise<{text:string;state:SafeBookingState}> {
  const context=await loadContext(), prior=previous||{}, safe=redact(message), turns=prior.recentTurns||[];
  const service=serviceFor(prior.serviceName,context.services);
  const liveAvailability=prior.dateIso&&prior.time24h&&service ? await checkAvailability(prior.dateIso,prior.time24h,service,context.settings) : {reason:"not_checked"};
  const result=await generateObject({
    model:bookingModel,schema,
    system:"You are Luna, the complete WashPoint booking agent. Today in Malaysia is "+todayMalaysia()+". Use the live context as authoritative knowledge. Understand English, Malay, Manglish, shorthand, corrections and all customer context. Do not ask for information already in the draft. Ask one focused question at a time. Default to English unless the customer clearly uses Malay/Manglish. Collect service, date, time, name, Malaysian phone, car plate number, and car make/model. Never invent or carry forward a date or time as if the customer just requested it; only set dateIso/time24h when the latest customer message explicitly provides it or clearly confirms a previously proposed value. Never claim availability unless the result says available. Before handoff, present all details and obtain a clear yes/confirm. Set handoff true only after that confirmation. LIVE CONTEXT: "+JSON.stringify(context)+" AVAILABILITY: "+JSON.stringify(liveAvailability),
    prompt:"DRAFT: "+JSON.stringify(prior)+"\nCONVERSATION:\n"+(turns.map(t=>t.role+": "+t.content).join("\n")||"(none)")+"\nLATEST CUSTOMER MESSAGE:\n"+safe,
    providerOptions:{gateway:{disallowPromptTraining:true} satisfies GatewayProviderOptions},
  });
  let state:SafeBookingState={...prior,bookingRequestId:prior.bookingRequestId||randomUUID(),serviceName:serviceFor(result.object.serviceName,context.services)?.name||prior.serviceName,dateIso:validDate(result.object.dateIso)||prior.dateIso,time24h:validTime(result.object.time24h)||prior.time24h,customerName:result.object.customerName||prior.customerName,customerPhone:findPhone(message)||prior.customerPhone,vehiclePlate:result.object.vehiclePlate||prior.vehiclePlate,vehicleMakeModel:result.object.vehicleMakeModel||prior.vehicleMakeModel,language:result.object.language,status:"collecting",lastActiveAt:new Date().toISOString()};
  if(result.object.intent==="restart")state={bookingRequestId:randomUUID(),language:result.object.language,status:"collecting",lastActiveAt:new Date().toISOString()};
  let text=result.object.reply;
  const selectedService=serviceFor(state.serviceName,context.services);
  const selectedSlot=state.dateIso&&state.time24h&&selectedService ? await checkAvailability(state.dateIso,state.time24h,selectedService,context.settings) : undefined;
  // Only enforce a slot result when this turn is about choosing/changing a
  // booking slot. A stale draft must not hijack unrelated questions such as
  // catalogue, pricing, opening hours, or cancellation requests.
  const slotChanged = state.dateIso !== prior.dateIso || state.time24h !== prior.time24h || state.serviceName !== prior.serviceName;
  const isSlotTurn = ["new_booking", "reschedule"].includes(result.object.intent) || slotChanged;
  if(isSlotTurn && selectedSlot&&!selectedSlot.available){
    state.status="collecting";
    result.object.handoff=false;
    text=selectedSlot.reason==="too_far" ? "Sorry, we only accept bookings up to "+context.settings.max_advance_days+" days in advance. Please choose an earlier date." : selectedSlot.reason==="closed" ? "Sorry, we are closed on that date. Please choose another date." : selectedSlot.reason==="fully_booked" ? "That specific time is fully booked. The whole day may not be full—please choose another time or date." : selectedSlot.reason==="outside_hours" ? "That time is outside our operating hours. Please choose another time." : "I couldn't check availability right now. Please try again shortly.";
  }
  if(result.object.handoff&&state.serviceName&&state.dateIso&&state.time24h&&state.customerName&&state.customerPhone&&state.vehiclePlate&&state.vehicleMakeModel){state.status="completed";text=await submitBooking(state,context,chatId);}
  console.info("[booking-agent] luna decision",{intent:result.object.intent,language:state.language,service:state.serviceName,date:state.dateIso,time:state.time24h,hasName:Boolean(state.customerName),hasPhone:Boolean(state.customerPhone),handoff:result.object.handoff,status:state.status});
  state.recentTurns=[...turns,{role:"user" as const,content:safe},{role:"assistant" as const,content:redact(text)}].slice(-10);
  return {text:text||"What would you like to book?",state};
}
