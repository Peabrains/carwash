import { managePublicBooking } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function POST(request: Request) {
  try {
    const body = await request.json() as { reference?: string; phone?: string; name?: string; vehicle_plate?: string; action?: "lookup" | "cancel" | "reschedule"; date?: string; time?: string };
    const reference = body.reference?.trim() || "";
    const phone = body.phone?.trim() || "";
    const name = body.name?.trim() || "";
    const vehiclePlate = body.vehicle_plate?.trim() || "";
    const action = body.action || "lookup";
    if ((!reference && (!phone || !name || !vehiclePlate)) || !["lookup", "cancel", "reschedule"].includes(action)) return json({ error: "Enter a booking reference, or provide the customer name, phone number and car plate." }, 400);
    const result = await managePublicBooking({ reference, phone, name, vehiclePlate, action, dateIso: body.date, time: body.time });
    return json({ booking: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage booking";
    return json({ error: message }, message.includes("could not find") || message.includes("already") ? 404 : 400);
  }
}
