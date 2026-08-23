import "../src/env.js";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required");
if (!getApps().length) initializeApp({ credential: cert(JSON.parse(raw)) });
const db = getFirestore();
const providerId = "washpoint";
const locationId = "washpoint-main";
const now = new Date().toISOString();

await db.collection("providers").doc(providerId).set({ name: "WashPoint", status: "active", updated_at: now }, { merge: true });
await db.collection("locations").doc(locationId).set({ provider_id: providerId, name: "Main outlet", timezone: "Asia/Kuala_Lumpur", is_active: true, updated_at: now }, { merge: true });

const legacySettings = await db.collection("booking_settings").doc("main").get();
if (legacySettings.exists) {
  await db.collection("booking_settings").doc(locationId).set({ ...legacySettings.data(), provider_id: providerId, location_id: locationId, migrated_at: now }, { merge: true });
  await legacySettings.ref.set({ provider_id: providerId, location_id: locationId, migrated_at: now }, { merge: true });
}

const operational = ["services", "bays", "appointments", "blackout_dates", "bay_closures", "crew_break_schedule"];
const updated: Record<string, number> = {};
for (const name of operational) {
  const snapshot = await db.collection(name).get();
  const missing = snapshot.docs.filter(item => !item.data().provider_id || !item.data().location_id);
  for (let offset = 0; offset < missing.length; offset += 400) {
    const batch = db.batch();
    for (const item of missing.slice(offset, offset + 400)) batch.set(item.ref, { provider_id: providerId, location_id: locationId, migrated_at: now }, { merge: true });
    await batch.commit();
  }
  updated[name] = missing.length;
}

const staffSnapshot = await db.collection("staff").get();
const activeOwners = staffSnapshot.docs.filter(item => item.data().is_active === true && item.data().role === "owner");
for (const item of staffSnapshot.docs) {
  const value = item.data();
  const patch: Record<string, unknown> = { updated_at: now };
  if (!value.provider_id) patch.provider_id = providerId;
  if (!value.location_id) patch.location_id = locationId;
  if (activeOwners.length === 1 && item.id === activeOwners[0].id) patch.role = "platform_owner";
  await item.ref.set(patch, { merge: true });
}

console.info(JSON.stringify({ provider: providerId, location: locationId, operational_documents_backfilled: updated, staff_records: staffSnapshot.size, platform_owner_promoted: activeOwners.length === 1 }, null, 2));
