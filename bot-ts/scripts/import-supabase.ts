import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

type Row = { id: string; data: Record<string, any> };
type ExportFile = { collections: Record<string, Row[]> };

function parseEnv(path: string) {
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith("#") && line.includes("="))
    .map(line => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
}

const env = parseEnv(process.env.MIGRATION_ENV_PATH || ".migration/migration.env");
const supabaseUrl = env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const exportPath = process.env.FIREBASE_EXPORT_PATH || ".migration/firebase-export.json";
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in migration.env");
if (!existsSync(exportPath)) throw new Error(`Missing Firebase export: ${exportPath}`);

const source = JSON.parse(readFileSync(exportPath, "utf8")) as ExportFile;
const mapPath = process.env.MIGRATION_ID_MAP_PATH || ".migration/id-map.json";
const idMap: { services: Record<string, string>; bays: Record<string, string> } = existsSync(mapPath)
  ? JSON.parse(readFileSync(mapPath, "utf8"))
  : { services: {}, bays: {} };

function stableUuid(kind: string, legacyId: string) {
  const hash = createHash("sha1").update(`docket:${kind}:${legacyId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mapped(kind: "services" | "bays", legacyId: string) {
  idMap[kind][legacyId] ||= stableUuid(kind, legacyId);
  return idMap[kind][legacyId];
}

function iso(value: unknown) {
  if (value && typeof value === "object" && "_seconds" in value) {
    const timestamp = value as { _seconds: number; _nanoseconds?: number };
    return new Date(timestamp._seconds * 1000 + Number(timestamp._nanoseconds || 0) / 1_000_000).toISOString();
  }
  if (typeof value === "string" && value) return new Date(value).toISOString();
  return new Date().toISOString();
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${body.slice(0, 1000)}`);
  return body ? JSON.parse(body) : null;
}

async function upsert(table: string, rows: Record<string, any>[], conflict: string) {
  if (!rows.length) return;
  await request(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

const providers = (source.collections.providers || []).map(row => ({
  id: row.id,
  name: row.data.name || row.data.display_name || row.id,
  description: row.data.description || "",
  status: row.data.status || "active",
}));
const locations = (source.collections.locations || []).map(row => ({
  id: row.id,
  provider_id: row.data.provider_id || "washpoint",
  name: row.data.name || row.data.display_name || row.id,
  address: row.data.address || "",
  timezone: row.data.timezone || "Asia/Kuala_Lumpur",
  is_active: row.data.is_active !== false && row.data.status !== "inactive",
}));
await upsert("providers", providers, "id");
await upsert("locations", locations, "id");

const services = (source.collections.services || []).map(row => ({
  id: mapped("services", row.id),
  provider_id: row.data.provider_id || "washpoint",
  location_id: row.data.location_id || "washpoint-main",
  name: row.data.name || row.id,
  duration_minutes: Number(row.data.duration_minutes),
  price_myr: Number(row.data.price_myr),
  is_active: row.data.is_active !== false,
}));
const bays = (source.collections.bays || []).map(row => ({
  id: mapped("bays", row.id),
  provider_id: row.data.provider_id || "washpoint",
  location_id: row.data.location_id || "washpoint-main",
  name: row.data.name || row.id,
  is_active: row.data.is_active !== false,
  status: row.data.status || "open",
}));
await upsert("services", services, "id");
await upsert("bays", bays, "id");

for (const row of source.collections.booking_settings || []) {
  await upsert("booking_settings", [{
    id: 1,
    provider_id: row.data.provider_id || "washpoint",
    location_id: row.data.location_id || "washpoint-main",
    min_lead_minutes: Number(row.data.min_lead_minutes ?? 60),
    max_advance_days: Number(row.data.max_advance_days ?? 14),
    buffer_minutes: Number(row.data.buffer_minutes ?? 15),
    weekday_open: row.data.weekday_open || "08:00",
    weekday_close: row.data.weekday_close || "19:00",
    weekend_open: row.data.weekend_open || "08:00",
    weekend_close: row.data.weekend_close || "21:00",
  }], "id");
}

const appointments = (source.collections.appointments || []).map(row => {
  const value = row.data;
  return {
    id: randomUUID(),
    provider_id: value.provider_id || "washpoint",
    location_id: value.location_id || "washpoint-main",
    booking_request_id: value.booking_request_id || `firebase:${row.id}`,
    reference: value.reference || `FIREBASE-${row.id}`,
    customer_id: value.customer_id || value.customer_chat_id || `firebase:${row.id}`,
    customer_chat_id: value.customer_chat_id || value.customer_id || `firebase:${row.id}`,
    customer_name: value.customer_name || null,
    customer_phone: value.customer_phone || null,
    channel: ["telegram", "whatsapp", "web", "staff"].includes(value.channel) ? value.channel : "telegram",
    vehicle_id: value.vehicle_id || null,
    vehicle_plate: value.vehicle_plate || null,
    service_id: mapped("services", value.service_id),
    bay_id: mapped("bays", value.bay_id),
    scheduled_at: iso(value.scheduled_at),
    scheduled_date: value.scheduled_date || iso(value.scheduled_at).slice(0, 10),
    duration_minutes: Number(value.duration_minutes),
    price_myr: Number(value.price_myr),
    status: value.status || "pending",
    payment_status: value.payment_status || "unpaid",
    needs_attention: value.needs_attention === true,
    created_at: iso(value.created_at),
  };
});
await upsert("appointments", appointments, "reference");

const locks = (source.collections.booking_day_locks || []).map(row => ({
  provider_id: row.data.provider_id || "washpoint",
  location_id: row.data.location_id || "washpoint-main",
  scheduled_date: row.data.date || row.data.scheduled_date,
  bay_id: mapped("bays", row.data.bay_id),
  revision: Number(row.data.revision || 0),
  updated_at: iso(row.data.updated_at),
}));
await upsert("booking_day_locks", locks, "location_id,scheduled_date,bay_id");

writeFileSync(mapPath, JSON.stringify(idMap, null, 2));
console.info(JSON.stringify({
  providers: providers.length,
  locations: locations.length,
  services: services.length,
  bays: bays.length,
  appointments: appointments.length,
  booking_day_locks: locks.length,
  staff: source.collections.staff?.length || 0,
  staff_note: "Staff auth records require Supabase Auth identity matching and are intentionally handled in the auth migration step.",
}, null, 2));
