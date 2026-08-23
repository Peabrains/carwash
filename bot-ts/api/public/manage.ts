import { managePublicBooking } from "../../src/supabase-booking.js";
import { json, options } from "./_shared.js";

export async function OPTIONS() { return options(); }

export async function POST(request: Request) {
  try {
    const body = await request.json() as { reference?: string; phone?: string; action?: "lookup" | "cancel" | "reschedule"; date?: string; time?: string };
    const reference = body.reference?.trim() || "";
    const phone = body.phone?.trim() || "";
    const action = body.action || "lookup";
    if (!reference || !phone || !["lookup", "cancel", "reschedule"].includes(action)) return json({ error: "Enter your booking reference and phone number." }, 400);
    const result = await managePublicBooking({ reference, phone, action, dateIso: body.date, time: body.time });
    return json({ booking: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to manage booking";
    return json({ error: message }, message.includes("could not find") || message.includes("already") ? 404 : 400);
  }
}
