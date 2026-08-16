import "./env.js";
import { createClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { z } from "zod";
import type { GatewayProviderOptions } from "@ai-sdk/gateway";
import { bookingModel } from "./model.js";

type Turn = { role: "user" | "assistant"; content: string };
export type SafeBookingState = {
  serviceName?: string; dateIso?: string; time24h?: string;
  customerName?: string; customerPhone?: string; language?: "en" | "ms";
  status?: "collecting" | "awaiting_confirmation" | "completed";
  recentTurns?: Turn[]; lastActiveAt?: string;
};
type Service = { id: string; name: string; duration_minutes: number; price_myr: number };
type Settings = { min_lead_minutes: number; max_advance_days: number; buffer_minutes: number; weekday_open: string; weekday_close: string; weekend_open: string; weekend_close: string };
type Availability = { available: boolean; bayId?: string; reason: string };
const schema = z.object({ reply: z.string(), intent: z.enum(["new_booking","answer","restart","cancel","reschedule","other"]), language: z.enum(["en","ms"]), serviceName: z.string().nullable(), dateIso: z.string().nullable(), time24h: z.string().nullable(), customerName: z.string().nullable(), handoff: z.boolean() });
const fallback: Settings = { min_lead_minutes: 60, max_advance_days: 14, buffer_minutes: 15, weekday_open: "08:00", weekday_close: "19:00", weekend_open: "08:00", weekend_close: "21:00" };
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null;
function redact(text: string) { return text.replace(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, "[PHONE REDACTED]"); }
function findPhone(text: string) { const m = text.match(/(?:\+?6?0)1[0-9][\s-]?\d{3,4}[\s-]?\d{3,4}\b/); return m && m[0].replace(/[\s-]/g, ""); }
function todayMalaysia() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function serviceFor(name: string | null | undefined, services: Service[]) { if (!name) return undefined; const n = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return services.find(s => { const c = s.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return c === n || c.includes(n) || n.includes(c); }); }
function validDate(v?: string | null) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined; }
function validTime(v?: string | null) { return v && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined; }
function mins(v: string) { const p = v.slice(0,5).split(":").map(Number); return p[0] * 60 + p[1]; }

async function loadContext(): Promise<{ services: Service[]; settings: Settings }> {
  if (!supabase) return { services: [], settings: fallback };
  const [a,b] = await Promise.all([
    supabase.from("services").select("id,name,duration_minutes,price_myr").eq("is_active", true).order("name"),
    supabase.from("booking_settings").select("min_lead_minutes,max_advance_days,buffer_minutes,weekday_open,weekday_close,weekend_open,weekend_close").eq("id", 1).maybeSingle(),
  ]);
  const r = b.data;
  const settings: Settings = r ? { min_lead_minutes: Number(r.min_lead_minutes)||60, max_advance_days: Number(r.max_advance_days)||14, buffer_minutes: Number(r.buffer_minutes)||15, weekday_open: r.weekday_open||"08:00", weekday_close: r.weekday_close||"19:00", weekend_open: r.weekend_open||"08:00", weekend_close: r.weekend_close||"21:00" } : fallback;
  return { services: (a.data || []) as Service[], settings };
}
async function checkAvailability(dateIso: string, time: string, service: Service, settings: Settings): Promise<Availability> {
  if (!supabase) return { available: false, reason: "unavailable" };
  const latest = new Date(todayMalaysia() + "T12:00:00+08:00");
  latest.setUTCDate(latest.getUTCDate() + settings.max_advance_days);
  if (new Date(dateIso + "T12:00:00+08:00").getTime() > latest.getTime()) return { available: false, reason: "too_far" };
  const requested = new Date(dateIso + "T" + time + ":00+08:00");
  const day = new Date(dateIso + "T12:00:00+08:00").getUTCDay();
  const open = day === 0 || day === 6 ? settings.weekend_open : settings.weekday_open;
  const close = day === 0 || day === 6 ? settings.weekend_close : settings.weekday_close;
  if (mins(time) < mins(open) || mins(time) + service.duration_minutes > mins(close)) return { available:false, reason:"outside_hours" };
  if (requested.getTime() < Date.now() + settings.min_lead_minutes * 60000) return { available:false, reason:"too_soon" };
  const startIso = dateIso + "T00:00:00+08:00", endIso = dateIso + "T23:59:59+08:00";
  const [blackout,bays,appts,breaks,closures] = await Promise.all([
    supabase.from("blackout_dates").select("label").eq("date", dateIso),
    supabase.from("bays").select("id").eq("is_active", true).eq("status", "open"),
    supabase.from("appointments").select("bay_id,scheduled_at,duration_minutes").neq("status","cancelled").gte("scheduled_at",startIso).lte("scheduled_at",endIso),
    supabase.from("crew_break_schedule").select("bay_id,start_time,duration_minutes"),
    supabase.from("bay_closures").select("bay_id,starts_at,ends_at").lte("starts_at",endIso).gte("ends_at",startIso),
  ]);
  if ([blackout,bays,appts,breaks,closures].some(x => x.error)) return { available:false, reason:"unavailable" };
  if ((blackout.data || []).length) return { available:false, reason:"closed" };
  const start=requested.getTime(), end=start+service.duration_minutes*60000, overlap=(a:number,b:number,c:number,d:number)=>a<d&&c<b;
  for (const bay of (bays.data || []) as {id:string}[]) {
    const busy=(appts.data||[]).some(a=>{if(a.bay_id!==bay.id)return false;const s=new Date(a.scheduled_at).getTime();return overlap(start,end,s,s+Number(a.duration_minutes)*60000+settings.buffer_minutes*60000);});
    const breakBusy=(breaks.data||[]).some(b=>{if(b.bay_id!==bay.id)return false;const s=new Date(dateIso+"T"+String(b.start_time).slice(0,5)+":00+08:00").getTime();return overlap(start,end,s,s+Number(b.duration_minutes)*60000);});
    const closed=(closures.data||[]).some(c=>c.bay_id===bay.id&&overlap(start,end,new Date(c.starts_at).getTime(),new Date(c.ends_at).getTime()));
    if(!busy&&!breakBusy&&!closed)return {available:true,bayId:bay.id,reason:"available"};
  }
  return {available:false,reason:"fully_booked"};
}

async function submitBooking(state: SafeBookingState, context: {services:Service[];settings:Settings}, chatId: string): Promise<string> {
  if(!supabase||!state.serviceName||!state.dateIso||!state.time24h||!state.customerName||!state.customerPhone)return "I still need the complete booking details before submitting.";
  const service=serviceFor(state.serviceName,context.services); if(!service)return "I couldn't match that service to the live catalogue.";
  const slot=await checkAvailability(state.dateIso,state.time24h,service,context.settings); if(!slot.available||!slot.bayId)return "That slot is no longer available. Please choose another time.";
  const reference="WP-"+state.dateIso.replaceAll("-","")+"-"+Math.floor(1000+Math.random()*9000);
  const result=await supabase.from("appointments").insert({customer_chat_id:chatId,customer_name:state.customerName,customer_phone:state.customerPhone,channel:"telegram",bay_id:slot.bayId,service_id:service.id,scheduled_at:new Date(state.dateIso+"T"+state.time24h+":00+08:00").toISOString(),duration_minutes:service.duration_minutes,price_myr:service.price_myr,status:"confirmed",reference});
  if(result.error){console.error("[booking-agent] handoff failed",{error:result.error.message});return "I couldn't complete that booking. Nothing was confirmed—please try again.";}
  return "Confirmed — "+service.name+" on "+state.dateIso+" at "+state.time24h+". Your reference is "+reference+".";
}

export async function respondToCustomer(message: string, previous: SafeBookingState | null, chatId = "unknown"): Promise<{text:string;state:SafeBookingState}> {
  const context=await loadContext(), prior=previous||{}, safe=redact(message), turns=prior.recentTurns||[];
  const service=serviceFor(prior.serviceName,context.services);
  const liveAvailability=prior.dateIso&&prior.time24h&&service ? await checkAvailability(prior.dateIso,prior.time24h,service,context.settings) : {reason:"not_checked"};
  const result=await generateObject({
    model:bookingModel,schema,
    system:"You are Luna, the complete WashPoint booking agent. Today in Malaysia is "+todayMalaysia()+". Use the live context as authoritative knowledge. Understand English, Malay, Manglish, shorthand, corrections and all customer context. Do not ask for information already in the draft. Ask one focused question at a time. Default to English unless the customer clearly uses Malay/Manglish. Collect service, date, time, name and Malaysian phone. Never claim availability unless the result says available. Before handoff, present all details and obtain a clear yes/confirm. Set handoff true only after that confirmation. LIVE CONTEXT: "+JSON.stringify(context)+" AVAILABILITY: "+JSON.stringify(liveAvailability),
    prompt:"DRAFT: "+JSON.stringify(prior)+"\nCONVERSATION:\n"+(turns.map(t=>t.role+": "+t.content).join("\n")||"(none)")+"\nLATEST CUSTOMER MESSAGE:\n"+safe,
    providerOptions:{gateway:{disallowPromptTraining:true} satisfies GatewayProviderOptions},
  });
  let state:SafeBookingState={...prior,serviceName:serviceFor(result.object.serviceName,context.services)?.name||prior.serviceName,dateIso:validDate(result.object.dateIso)||prior.dateIso,time24h:validTime(result.object.time24h)||prior.time24h,customerName:result.object.customerName||prior.customerName,customerPhone:findPhone(message)||prior.customerPhone,language:result.object.language,status:"collecting",lastActiveAt:new Date().toISOString()};
  if(result.object.intent==="restart")state={language:result.object.language,status:"collecting",lastActiveAt:new Date().toISOString()};
  let text=result.object.reply;
  const selectedService=serviceFor(state.serviceName,context.services);
  const selectedSlot=state.dateIso&&state.time24h&&selectedService ? await checkAvailability(state.dateIso,state.time24h,selectedService,context.settings) : undefined;
  if(selectedSlot&&!selectedSlot.available){
    state.status="collecting";
    result.object.handoff=false;
    text=selectedSlot.reason==="too_far" ? "Sorry, we only accept bookings up to "+context.settings.max_advance_days+" days in advance. Please choose an earlier date." : selectedSlot.reason==="closed" ? "Sorry, we are closed on that date. Please choose another date." : selectedSlot.reason==="fully_booked" ? "Sorry, that slot is fully booked. Please choose another time or date." : selectedSlot.reason==="outside_hours" ? "That time is outside our operating hours. Please choose another time." : "I couldn't check availability right now. Please try again shortly.";
  }
  if(result.object.handoff&&state.serviceName&&state.dateIso&&state.time24h&&state.customerName&&state.customerPhone){state.status="completed";text=await submitBooking(state,context,chatId);}
  console.info("[booking-agent] luna decision",{intent:result.object.intent,language:state.language,service:state.serviceName,date:state.dateIso,time:state.time24h,hasName:Boolean(state.customerName),hasPhone:Boolean(state.customerPhone),handoff:result.object.handoff,status:state.status});
  state.recentTurns=[...turns,{role:"user",content:safe},{role:"assistant",content:redact(text)}].slice(-10);
  return {text:text||"What would you like to book?",state};
}
