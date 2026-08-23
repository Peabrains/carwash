import { publicSupabaseClient } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function GET() {
  try {
    const db = publicSupabaseClient();
    const [{ data: providers, error: providerError }, { data: locations, error: locationError }, { data: services, error: serviceError }] = await Promise.all([
      db.from("providers").select("id,name,description,status").eq("status", "active").order("name"),
      db.from("locations").select("id,provider_id,name,address,timezone,is_active").eq("is_active", true).order("name"),
      db.from("services").select("id,provider_id,location_id,name,duration_minutes,price_myr,is_active").eq("is_active", true).order("name"),
    ]);
    if (providerError || locationError || serviceError) throw new Error((providerError || locationError || serviceError)?.message || "Unable to load catalogue");
    return json({ providers: providers || [], locations: locations || [], services: services || [] });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load catalogue" }, 500);
  }
}
