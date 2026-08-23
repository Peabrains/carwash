import { availableSupabaseSlots, loadSupabaseBookingContext, publicSupabaseClient } from "../../src/supabase-booking.js";
import { json, options, requiredTenant } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const tenant = requiredTenant(url);
    const date = url.searchParams.get("date") || "";
    const serviceId = url.searchParams.get("service_id") || "";
    if (!tenant || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-f0-9-]{20,}$/.test(serviceId)) return json({ error: "provider_id, location_id, date and service_id are required" }, 400);
    const context = await loadSupabaseBookingContext(tenant);
    const service = context.services.find(item => item.id === serviceId);
    if (!service) return json({ error: "Service not found" }, 404);
    return json({ date, service_id: serviceId, slots: await availableSupabaseSlots(context, tenant, date, service) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to load availability" }, 500);
  }
}
