import { availableSupabaseSlots, loadSupabaseBookingContext, publicSupabaseClient } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date") || "";
    const time = url.searchParams.get("time") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
      return json({ error: "Choose a valid date and optional time." }, 400);
    }
    const db = publicSupabaseClient();
    const [{ data: providers, error: providerError }, { data: locations, error: locationError }, { data: services, error: serviceError }] = await Promise.all([
      db.from("providers").select("id,name,description,status").eq("status", "active").order("name"),
      db.from("locations").select("id,provider_id,name,address,timezone,is_active").eq("is_active", true).order("name"),
      db.from("services").select("id,provider_id,location_id,name,duration_minutes,price_myr,is_active").eq("is_active", true).order("name"),
    ]);
    if (providerError || locationError || serviceError) throw new Error((providerError || locationError || serviceError)?.message || "Unable to load catalogue");

    const contextCache = new Map<string, Awaited<ReturnType<typeof loadSupabaseBookingContext>>>();
    const matches = [];
    for (const service of services || []) {
      const provider = (providers || []).find(item => item.id === service.provider_id);
      const location = (locations || []).find(item => item.id === service.location_id && item.provider_id === service.provider_id);
      if (!provider || !location) continue;
      const cacheKey = `${service.provider_id}|${service.location_id}`;
      let context = contextCache.get(cacheKey);
      if (!context) {
        context = await loadSupabaseBookingContext({ providerId: service.provider_id, locationId: service.location_id });
        contextCache.set(cacheKey, context);
      }
      const liveService = context.services.find(item => item.id === service.id);
      if (!liveService) continue;
      const slots = await availableSupabaseSlots(context, { providerId: service.provider_id, locationId: service.location_id }, date, liveService, time || undefined);
      if (slots.length) matches.push({ provider, location, service, slots });
    }
    return json({ date, time, matches });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to search availability" }, 500);
  }
}
