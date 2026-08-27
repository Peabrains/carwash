import { randomUUID } from "node:crypto";
import { reserveSupabaseAppointment } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function POST(request: Request) {
  try {
    const body = await request.json() as { provider_id?: string; location_id?: string; service_id?: string; date?: string; time?: string; name?: string; phone?: string; vehicle_plate?: string; vehicle_make_model?: string };
    const providerId = body.provider_id || "";
    const locationId = body.location_id || "";
    const serviceId = body.service_id || "";
    const date = body.date || "";
    const time = body.time || "";
    const name = body.name?.trim() || "";
    const phone = body.phone?.replace(/[\s-]/g, "") || "";
    const vehiclePlate = body.vehicle_plate?.trim() || "";
    const vehicleMakeModel = body.vehicle_make_model?.trim() || "";
    if (!/^[a-z0-9-]+$/.test(providerId) || !/^[a-z0-9-]+$/.test(locationId) || !/^[a-f0-9-]{20,}$/.test(serviceId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !name || !/^(?:01\d{8,9}|\+?601\d{8,9})$/.test(phone) || !vehiclePlate || !vehicleMakeModel) return json({ error: "Please provide your name, Malaysian phone number, car plate and car make/model." }, 400);
    const result = await reserveSupabaseAppointment(`web:${randomUUID()}`, { step: "confirm", bookingRequestId: randomUUID(), serviceId, dateIso: date, time24h: time, customerName: name, customerPhone: phone, vehiclePlate, vehicleMakeModel }, { providerId, locationId }, "web");
    if (result.status === "unavailable") return json({ error: "That slot is no longer available." }, 409);
    return json({ reference: result.reference, service: result.service }, result.status === "created" ? 201 : 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to create booking" }, 500);
  }
}
