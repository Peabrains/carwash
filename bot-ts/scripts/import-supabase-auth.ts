import { existsSync, readFileSync } from "node:fs";

type Row = { id: string; data: Record<string, any> };

function parseEnv(path: string) {
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith("#") && line.includes("="))
    .map(line => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
}

const env = parseEnv(process.env.MIGRATION_ENV_PATH || ".migration/migration.env");
const url = env.SUPABASE_URL?.replace(/\/$/, "");
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const exportPath = process.env.FIREBASE_EXPORT_PATH || ".migration/firebase-export.json";
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
if (!existsSync(exportPath)) throw new Error(`Missing Firebase export: ${exportPath}`);
const source = JSON.parse(readFileSync(exportPath, "utf8")) as { collections: Record<string, Row[]> };

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${body.slice(0, 1000)}`);
  return body ? JSON.parse(body) : null;
}

const users = await request("/auth/v1/admin/users?page=1&per_page=1000");
const existing = new Map<string, any>((users.users || []).map((user: any) => [String(user.email || "").toLowerCase(), user]));
const imported: Array<{ email: string; id: string; created: boolean }> = [];

for (const row of source.collections.staff || []) {
  const value = row.data;
  const email = String(value.email || row.id).trim().toLowerCase();
  if (!email.includes("@")) throw new Error(`Invalid staff email: ${email}`);
  let user = existing.get(email);
  let created = false;
  if (!user) {
    user = await request("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, email_confirm: true, user_metadata: { name: value.name || email } }),
    });
    created = true;
  }
  await request("/rest/v1/staff?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      id: user.id,
      email,
      name: value.name || email,
      role: value.role === "platform_owner" ? "platform_owner" : value.role || "worker",
      provider_id: value.provider_id || "washpoint",
      location_id: value.location_id || "washpoint-main",
      is_active: value.is_active !== false,
    }]),
  });
  imported.push({ email, id: user.id, created });
}

console.info(JSON.stringify({ imported }, null, 2));
