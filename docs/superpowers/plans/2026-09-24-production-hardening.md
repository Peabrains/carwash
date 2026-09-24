# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:verification-before-completion before claiming completion.

**Goal:** Make Docket/WashPoint safe for a controlled paid production pilot.

**Architecture:** Keep GitHub Pages as the public frontend, Supabase Account B as the system of record, and Vercel as the server/API and Telegram runtime. Remove Firebase from active runtime paths, preserve only clearly isolated migration history, and add automated release gates around the frontend and bot.

**Tech Stack:** Vite/PWA, Supabase Auth/Postgres/RPC, Vercel serverless functions, Telegram Chat SDK, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-28-carwash-booking-app-design.md`

## Global Constraints

- Supabase Account B and project `frfmbulazzvmxfclrjxj` remain the Docket production target.
- No service-role keys, Telegram tokens, Firebase service accounts, or PATs may enter public client code or git.
- Booking confirmation must remain atomic and server-authoritative.
- Preserve unrelated dirty-worktree changes.
- Do not delete migration evidence without explicit authorization.

## Review Focus

- Firebase runtime code: production booking paths must not import or call Firebase.
- Public booking: invalid, stale, duplicate, and concurrent booking requests must fail safely.
- Tenant isolation: staff/provider access must remain scoped by provider and location.
- PWA release freshness: root-domain assets and service-worker updates must work after deployment.
- Production data: placeholder addresses/services must not be exposed to customers.

### Task 1: Remove Firebase from runtime booking paths

**Files:** `bot-ts/src/tier1-flow.ts`, `bot-ts/api/appointments.ts`, `bot-ts/package.json`, `bot-ts/package-lock.json`.

- [ ] Write tests proving the Supabase booking context and atomic reservation are used.
- [ ] Remove Firebase imports and fallback branches from runtime files.
- [ ] Delete the obsolete Firebase appointment API or route it through the Supabase booking implementation.
- [ ] Remove `firebase-admin` only after runtime imports are gone; retain migration scripts and historical export files untouched.
- [ ] Run bot typecheck and tests.

### Task 2: Add production release gates

**Files:** `.github/workflows/deploy-pages.yml`, `bot-ts/package.json`, optionally `.github/workflows/verify.yml`.

- [ ] Run frontend build and bot typecheck/tests before Pages deployment.
- [ ] Add `git diff --check` to the release gate.
- [ ] Pin currently floating bot dependencies where lockfile versions already exist.
- [ ] Keep `VITE_BASE_PATH=/` for the custom domain and preserve PWA auto-update registration.

### Task 3: Expand booking and authorization tests

**Files:** `bot-ts/test/booking-rules.test.ts`, new focused tests under `bot-ts/test/`.

- [ ] Cover duplicate booking, stale slot, closure/break overlap, invalid vehicle/customer fields, cancellation, and rescheduling rules.
- [ ] Add pure authorization tests for provider/location scoping.
- [ ] Add a public API smoke-test fixture that validates catalog and required-parameter failures without writing production data.

### Task 4: Clean production seed/configuration data

**Files:** Supabase seed/configuration through the Account B workspace, and any checked-in seed/reference files.

- [ ] Replace placeholder addresses and test service names with approved WashPoint values.
- [ ] Confirm production service prices, duration, opening hours, bays, buffers, blackout dates, and Telegram bot mapping.
- [ ] Verify RLS policies and booking RPC grants using the mapped Account B project.

### Task 5: Verify deployment and pilot readiness

- [ ] Verify the deployed Pages commit, root asset paths, service worker, and custom-domain HTTPS.
- [ ] Verify Vercel catalog, slots, booking validation, manage-booking, and Telegram webhook responses.
- [ ] Run a controlled end-to-end booking smoke test using a disposable/test slot.
- [ ] Record unresolved items and pilot go/no-go criteria.

