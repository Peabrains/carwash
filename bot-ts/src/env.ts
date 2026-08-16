import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

// Local development can reuse the existing Python bot credentials without copying
// secrets into source control. Vercel deployments use their configured env vars.
for (const path of ["../bot/.env", ".env"]) {
  if (!existsSync(path)) continue;
  const values = parse(readFileSync(path));
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]?.trim() && value.trim()) process.env[key] = value;
  }
}
