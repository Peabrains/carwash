import { createHash, timingSafeEqual } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { bookingIntervalsOverlap } from "../src/booking-rules.js";

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getFirestore();
}

function authorized(request: Request) {
  const expected = process.env.APPOINTMENTS_API_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as {
      request_id?: string; provider_id?: string; location_id?: string;
      customer_id?: string; customer_name?: string; customer_phone?: string;
      vehicle_id?: string | null; service_id?: string; scheduled_at?: string;
    };
    if (!body.request_id || !body.provider_id || !body.location_id || !body.customer_id || !body.service_id || !body.scheduled_at) {
      return Response.json({ error: "request_id, provider_id, location_id, customer_id, service_id and scheduled_at are required" }, { status: 400 });
    }
    const scheduledAt = body.scheduled_at;
    const dateIso = scheduledAt.slice(0, 10);
    const firestore = db();
    const hash = createHash("sha256").update(`${body.provider_id}|${body.location_id}|${body.request_id}`).digest("hex");
    const appointmentRef = firestore.collection("appointments").doc(`api_${hash.slice(0, 32)}`);

    const result = await firestore.runTransaction(async transaction => {
      const existing = await transaction.get(appointmentRef);
      if (existing.exists) return { id: existing.id, ...existing.data(), idempotent: true };
      const [serviceSnap, settingsSnap, baysSnap, bookingsSnap] = await Promise.all([
        transaction.get(firestore.collection("services").doc(body.service_id!)),
        transaction.get(firestore.collection("booking_settings").doc(body.location_id!)),
        transaction.get(firestore.collection("bays").where("location_id", "==", body.location_id)),
        transaction.get(firestore.collection("appointments").where("location_id", "==", body.location_id).where("scheduled_date", "==", dateIso)),
      ]);
      const service = serviceSnap.data(); const settings = settingsSnap.data();
      if (!serviceSnap.exists || !service || service.is_active === false || service.provider_id !== body.provider_id || service.location_id !== body.location_id) throw new Error("Service unavailable");
      if (!settings || settings.provider_id !== body.provider_id || settings.location_id !== body.location_id) throw new Error("Location settings unavailable");
      const bays = (baysSnap.docs.map(item => ({ id: item.id, ...item.data() })) as Array<{ id: string; provider_id?: string; is_active?: boolean; status?: string }>).filter(item => item.provider_id === body.provider_id && item.is_active !== false && item.status !== "maintenance");
      const lockRefs = bays.map(bay => firestore.collection("booking_day_locks").doc(`${body.provider_id}_${body.location_id}_${dateIso}_${bay.id}`));
      const locks = await Promise.all(lockRefs.map(ref => transaction.get(ref)));
      const start = new Date(scheduledAt).getTime(); const end = start + Number(service.duration_minutes) * 60_000;
      const bookings = bookingsSnap.docs.map(item => item.data()).filter(item => item.provider_id === body.provider_id && item.location_id === body.location_id && item.status !== "cancelled");
      const bay = bays.find(candidate => !bookings.some(booking => {
        if (booking.bay_id !== candidate.id) return false;
        const existingStart = new Date(booking.scheduled_at).getTime(); const existingEnd = existingStart + Number(booking.duration_minutes) * 60_000;
        return bookingIntervalsOverlap(start, end, existingStart, existingEnd, Number(settings.buffer_minutes || 0));
      }));
      if (!bay) throw new Error("No bay available for this time");
      const lockIndex = bays.findIndex(item => item.id === bay.id);
      transaction.set(lockRefs[lockIndex], { provider_id: body.provider_id, location_id: body.location_id, date: dateIso, bay_id: bay.id, revision: Number(locks[lockIndex].data()?.revision || 0) + 1, updated_at: new Date().toISOString() });
      const reference = `WP-${dateIso.replaceAll("-", "")}-${hash.slice(0, 6).toUpperCase()}`;
      const appointment = {
        provider_id: body.provider_id, location_id: body.location_id, booking_request_id: body.request_id,
        customer_id: body.customer_id, customer_name: body.customer_name || null, customer_phone: body.customer_phone || null,
        vehicle_id: body.vehicle_id ?? null, service_id: body.service_id, bay_id: bay.id,
        scheduled_at: scheduledAt, scheduled_date: dateIso, duration_minutes: service.duration_minutes, price_myr: service.price_myr,
        status: "pending", payment_status: "unpaid", needs_attention: false, reference, created_at: new Date().toISOString(),
      };
      transaction.create(appointmentRef, appointment);
      return { id: appointmentRef.id, ...appointment, idempotent: false };
    });
    return Response.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create appointment";
    return Response.json({ error: message }, { status: message === "No bay available for this time" ? 409 : 400 });
  }
}
