import "../src/env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH || ".migration/firebase-service-account.json";
if (!existsSync(envPath)) throw new Error(`Missing Firebase service account file: ${envPath}`);
const serviceAccount = JSON.parse(readFileSync(envPath, "utf8"));
if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();
const collections = [
  "providers", "locations", "staff", "services", "bays", "booking_settings",
  "blackout_dates", "bay_closures", "crew_break_schedule", "appointments", "booking_day_locks",
];

const exportData: Record<string, Array<{ id: string; data: unknown }>> = {};
for (const name of collections) {
  const snapshot = await db.collection(name).get();
  exportData[name] = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
}

const output = process.env.FIREBASE_EXPORT_PATH || ".migration/firebase-export.json";
writeFileSync(output, JSON.stringify({ exported_at: new Date().toISOString(), collections: exportData }, null, 2));
console.info(`Exported ${Object.values(exportData).reduce((total, rows) => total + rows.length, 0)} documents to ${output}`);
