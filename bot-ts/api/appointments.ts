import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

function db() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  return getFirestore();
}

function overlaps(start: string, duration: number, existingStart: string, existingDuration: number) {
  const startMs = new Date(start).getTime();
  const endMs = startMs + duration * 60_000;
  const existingStartMs = new Date(existingStart).getTime();
  const existingEndMs = existingStartMs + existingDuration * 60_000;
  return startMs < existingEndMs && existingStartMs < endMs;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      customer_id?: string;
      vehicle_id?: string | null;
      service_id?: string;
      scheduled_at?: string;
    };
    if (!body.customer_id || !body.service_id || !body.scheduled_at) {
      return Response.json({ error: "customer_id, service_id and scheduled_at are required" }, { status: 400 });
    }

    const firestore = db();
    const result = await firestore.runTransaction(async transaction => {
      const serviceSnap = await transaction.get(firestore.collection("services").doc(body.service_id!));
      if (!serviceSnap.exists || serviceSnap.data()?.is_active !== true) throw new Error("Service unavailable");
      const service = serviceSnap.data()!;
      const baysSnap = await transaction.get(firestore.collection("bays").where("is_active", "==", true));
      const bookingsSnap = await transaction.get(firestore.collection("appointments")
        .where("scheduled_date", "==", body.scheduled_at!.slice(0, 10))
        .where("status", "in", ["pending", "confirmed", "in_progress"]));
      const bookings = bookingsSnap.docs.map(item => item.data());
      const bay = baysSnap.docs.map(item => ({ id: item.id, ...item.data() })).find(candidate =>
        !bookings.some(booking => booking.bay_id === candidate.id && overlaps(
          body.scheduled_at!, Number(service.duration_minutes), booking.scheduled_at, Number(booking.duration_minutes))));
      if (!bay) throw new Error("No bay available for this time");

      const reference = `WP-${body.scheduled_at.slice(0, 10).replaceAll("-", "")}-${Math.floor(Math.random() * 9000 + 1000)}`;
      const appointmentRef = firestore.collection("appointments").doc();
      const appointment = {
        customer_id: body.customer_id,
        vehicle_id: body.vehicle_id ?? null,
        service_id: body.service_id,
        bay_id: bay.id,
        scheduled_at: body.scheduled_at,
        scheduled_date: body.scheduled_at.slice(0, 10),
        duration_minutes: service.duration_minutes,
        price_myr: service.price_myr,
        status: "pending",
        payment_status: "unpaid",
        needs_attention: false,
        reference,
        created_at: FieldValue.serverTimestamp(),
      };
      transaction.set(appointmentRef, appointment);
      return { id: appointmentRef.id, reference, status: appointment.status, payment_status: appointment.payment_status, bay_id: bay.id };
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create appointment";
    return Response.json({ error: message }, { status: message === "No bay available for this time" ? 409 : 400 });
  }
}
