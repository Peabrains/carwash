import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function getDb() {
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function overlaps(start, durationMinutes, existingStart, existingDuration) {
  const startMs = new Date(start).getTime();
  const endMs = startMs + durationMinutes * 60000;
  const existingStartMs = new Date(existingStart).getTime();
  const existingEndMs = existingStartMs + existingDuration * 60000;
  return startMs < existingEndMs && existingStartMs < endMs;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { customer_id, vehicle_id = null, service_id, scheduled_at } = req.body ?? {};
    if (!customer_id || !service_id || !scheduled_at) {
      return res.status(400).json({ error: 'customer_id, service_id and scheduled_at are required' });
    }

    const db = getDb();
    const result = await db.runTransaction(async transaction => {
      const serviceRef = db.collection('services').doc(service_id);
      const serviceSnap = await transaction.get(serviceRef);
      if (!serviceSnap.exists || serviceSnap.data().is_active !== true) throw new Error('Service unavailable');
      const service = serviceSnap.data();

      const baysSnap = await transaction.get(db.collection('bays').where('is_active', '==', true));
      const activeBays = baysSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const appointmentsSnap = await transaction.get(db.collection('appointments')
        .where('scheduled_date', '==', scheduled_at.slice(0, 10))
        .where('status', 'in', ['pending', 'confirmed', 'in_progress']));
      const existing = appointmentsSnap.docs.map(doc => doc.data());
      const freeBay = activeBays.find(bay => !existing.some(appt =>
        appt.bay_id === bay.id && overlaps(scheduled_at, service.duration_minutes, appt.scheduled_at, appt.duration_minutes)));
      if (!freeBay) throw new Error('No bay available for this time');

      const ref = `WP-${scheduled_at.slice(0, 10).replaceAll('-', '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
      const appointmentRef = db.collection('appointments').doc();
      const appointment = {
        customer_id, vehicle_id, service_id, bay_id: freeBay.id,
        scheduled_at, scheduled_date: scheduled_at.slice(0, 10),
        duration_minutes: service.duration_minutes, price_myr: service.price_myr,
        status: 'pending', payment_status: 'unpaid', needs_attention: false,
        reference: ref, created_at: FieldValue.serverTimestamp()
      };
      transaction.set(appointmentRef, appointment);
      return { id: appointmentRef.id, ...appointment, created_at: undefined };
    });

    return res.status(201).json(result);
  } catch (error) {
    const status = error.message === 'No bay available for this time' ? 409 : 400;
    return res.status(status).json({ error: error.message });
  }
}
