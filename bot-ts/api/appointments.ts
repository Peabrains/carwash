import { bearerToken, json, options } from "./public/_shared.js";
import { createManualBooking, type ManualBookingInput } from "../src/manual-booking.js";
import { publicSupabaseClient, reserveSupabaseAppointment } from "../src/supabase-booking.js";

export function OPTIONS(): Response { return options(); }

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const db = publicSupabaseClient();
  const { data: authData, error: authError } = await db.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Unauthorized" }, 401);
  const { data: staff, error: staffError } = await db.from("staff").select("id,role,provider_id,location_id,is_active").eq("id", authData.user.id).maybeSingle();
  if (staffError || !staff?.is_active) return json({ error: "Staff access required" }, 403);

  try {
    const body = await request.json() as Partial<ManualBookingInput>;
    const input: ManualBookingInput = {
      requestId: String(body.requestId || ""), providerId: String(body.providerId || ""), locationId: String(body.locationId || ""),
      customerName: String(body.customerName || ""), customerPhone: String(body.customerPhone || ""),
      vehiclePlate: String(body.vehiclePlate || ""), vehicleMakeModel: String(body.vehicleMakeModel || ""),
      serviceId: String(body.serviceId || ""), dateIso: String(body.dateIso || ""), time24h: String(body.time24h || ""),
      source: body.source as ManualBookingInput["source"], requestedBayId: body.requestedBayId ? String(body.requestedBayId) : undefined,
    };
    const result = await createManualBooking(input, { id: staff.id, role: staff.role, providerId: staff.provider_id, locationId: staff.location_id }, {
      canUseRequestedBay: async () => false,
      reserve: async details => {
        const reserved = await reserveSupabaseAppointment(`staff:${staff.id}`, {
          step: "confirm", bookingRequestId: details.requestId, serviceId: details.serviceId,
          dateIso: details.dateIso, time24h: details.time24h, customerName: details.customerName,
          customerPhone: details.customerPhone, vehiclePlate: details.vehiclePlate, vehicleMakeModel: details.vehicleMakeModel,
        }, { providerId: details.providerId, locationId: details.locationId }, "staff");
        if (reserved.status !== "unavailable") {
          const { error } = await db.from("appointments").update({ booking_source: details.source, created_by: staff.id }).eq("reference", reserved.reference).eq("provider_id", details.providerId);
          if (error) throw new Error(`Supabase recording manual booking source failed: ${error.message}`);
        }
        return reserved;
      },
    });
    if (result.status === "unavailable") return json({ error: "That slot is no longer available." }, 409);
    return json({ status: result.status, reference: result.reference }, result.status === "created" ? 201 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create appointment";
    const status = /required|choose a valid|own provider|assigned outlet|permission|unavailable/i.test(message) ? 400 : (/limit/.test(message) ? 409 : 500);
    return json({ error: message }, status);
  }
}
