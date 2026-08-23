#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileDir = resolve(repoRoot, "config", "supabase");
const activeFile = resolve(repoRoot, ".env.supabase.active");

function usage() {
  console.log(`Usage:
  node scripts/supabase-profile.mjs list
  node scripts/supabase-profile.mjs use <profile>
  node scripts/supabase-profile.mjs show <profile>
  node scripts/supabase-profile.mjs run <profile> -- <command> [args...]

Profiles are local files at config/supabase/<profile>.env.
Create one by copying the matching .example.env file.`);
}

function profilePath(name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name ?? "")) {
    throw new Error("Profile names may contain only letters, numbers, _ and -.");
  }
  return resolve(profileDir, `${name}.env`);
}

function loadEnv(file) {
  const values = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function requireProfile(name) {
  const file = profilePath(name);
  if (!existsSync(file)) {
    throw new Error(`Missing ${file}. Copy config/supabase/${name}.example.env to ${name}.env and fill it in.`);
  }
  return file;
}

function redact(key, value) {
  if (!value) return "(not set)";
  if (/KEY|TOKEN|SECRET/i.test(key)) return `${value.slice(0, 4)}…(hidden)`;
  return value;
}

const [command, name, ...rest] = process.argv.slice(2);

try {
  if (!command || command === "help" || command === "--help") {
    usage();
    process.exit(0);
  }

  if (command === "list") {
    const profiles = ["account-a", "account-b"].filter((profile) => existsSync(profilePath(profile)));
    console.log(profiles.length ? profiles.join("\n") : "No local profiles yet. Copy the example files first.");
    process.exit(0);
  }

  const file = requireProfile(name);
  const env = loadEnv(file);

  if (command === "show") {
    for (const key of ["SUPABASE_ACCOUNT_LABEL", "SUPABASE_PROJECT_REF", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ACCESS_TOKEN"]) {
      console.log(`${key}=${redact(key, env[key] ?? "")}`);
    }
    process.exit(0);
  }

  if (command === "use") {
    writeFileSync(activeFile, readFileSync(file));
    console.log(`Active Supabase profile set to ${env.SUPABASE_ACCOUNT_LABEL || name}.`);
    console.log("The active file is local-only and does not replace the Firebase .env.");
    process.exit(0);
  }

  if (command === "run") {
    if (rest[0] !== "--" || rest.length < 2) throw new Error("Use: run <profile> -- <command> [args...]");
    const childEnv = { ...process.env, ...env };
    const result = spawnSync(rest[1], rest.slice(2), { cwd: repoRoot, env: childEnv, stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(`Supabase profile error: ${error.message}`);
  process.exit(1);
}
