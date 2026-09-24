import { timingSafeEqual } from "node:crypto";
import { reserveSupabaseAppointment } from "../src/supabase-booking.js";

function authorized(request: Request) {
  const expected = process.env.APPOINTMENTS_API_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as { request_id?: string; provider_id?: string; location_id?: string; customer_id?: string; customer_name?: string; customer_phone?: string; vehicle_plate?: string; vehicle_make_model?: string; service_id?: string; scheduled_at?: string };
    if (!body.request_id || !body.provider_id || !body.location_id || !body.service_id || !body.scheduled_at || !body.customer_name || !body.customer_phone || !body.vehicle_plate || !body.vehicle_make_model) {
      return Response.json({ error: "request_id, provider_id, location_id, service_id, scheduled_at, customer_name, customer_phone, vehicle_plate and vehicle_make_model are required" }, { status: 400 });
    }
    const scheduledAt = new Date(body.scheduled_at);
    if (!Number.isFinite(scheduledAt.getTime())) return Response.json({ error: "scheduled_at must be a valid ISO timestamp" }, { status: 400 });
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(scheduledAt);
    const part = (type: string) => parts.find(item => item.type === type)?.value || "";
    const result = await reserveSupabaseAppointment(body.customer_id || `api:${body.request_id}`, { step: "confirm", bookingRequestId: body.request_id, serviceId: body.service_id, dateIso: `${part("year")}-${part("month")}-${part("day")}`, time24h: `${part("hour")}:${part("minute")}`, customerName: body.customer_name, customerPhone: body.customer_phone, vehiclePlate: body.vehicle_plate, vehicleMakeModel: body.vehicle_make_model }, { providerId: body.provider_id, locationId: body.location_id }, "web");
    if (result.status === "unavailable") return Response.json({ error: "That slot is no longer available." }, { status: 409 });
    return Response.json({ reference: result.reference, service: result.service }, { status: result.status === "created" ? 201 : 200 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to create appointment" }, { status: 500 });
  }
}
