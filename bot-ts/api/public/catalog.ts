import { publicSupabaseClient } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";
import { assertPrivateProviderBookable, listMarketplaceProviders } from "../../src/public-provider-access.js";

export async function OPTIONS() { return options(); }

export async function GET(request: Request) {
  try {
    const db = publicSupabaseClient();
    const url = new URL(request.url); const privateId = url.searchParams.get("access") === "private" ? url.searchParams.get("provider") || "" : "";
    const providers = privateId ? [await assertPrivateProviderBookable(db, privateId)] : await listMarketplaceProviders(db);
    const providerIds = new Set(providers.map(item => item.id));
    const [{ data: locations, error: locationError }, { data: services, error: serviceError }] = await Promise.all([
      db.from("locations").select("id,provider_id,name,address,timezone,is_active").eq("is_active", true).order("name"),
      db.from("services").select("id,provider_id,location_id,name,duration_minutes,price_myr,is_active").eq("is_active", true).order("name"),
    ]);
    if (locationError || serviceError) throw new Error((locationError || serviceError)?.message || "Unable to load catalogue");
    return json({ providers, locations: (locations || []).filter(item => providerIds.has(item.provider_id)), services: (services || []).filter(item => providerIds.has(item.provider_id)), access: privateId ? "private" : "marketplace" });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load catalogue" }, 500);
  }
}
