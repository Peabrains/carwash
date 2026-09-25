# Customer Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional customer email accounts, recovery, booking history, profiles, and saved vehicles while preserving guest booking and correcting the staff Google OAuth false error.

**Architecture:** Supabase Auth remains the single identity system. Customer-owned tables and appointment links use `auth.uid()` RLS; the trusted booking API validates an optional bearer token and passes only the verified user id into the atomic reservation. Guests continue through the same booking endpoint without a token or account link.

**Tech Stack:** Vite, vanilla JavaScript, Supabase Auth/Postgres/RLS, Vercel TypeScript API, Node test runner.

**Spec:** Conversation-approved design on 2026-09-25: email/password first; guests can book but have no account history; no automatic claiming of older guest bookings; password recovery included; payments deferred.

## Global Constraints

- Guest booking must remain available and unchanged.
- Only bookings made while authenticated are linked to an account.
- Never claim historical guest bookings by matching email, phone, name, or plate.
- Customer access must never grant staff/provider access.
- All customer-owned database rows require ownership-based RLS.
- Do not expose a service-role key in browser code.

## Review Focus

- A guest can still complete a booking with no Authorization header.
- An invalid bearer token is treated as unauthenticated and cannot link a booking to another user.
- Customer A cannot read or alter Customer B's profile, vehicles, or bookings.
- A customer session visiting staff routes is denied staff access.
- Password recovery returns a generic response and routes to the correct reset screen.

---

### Task 1: Correct staff Google OAuth redirect handling

**Files:**
- Create: `src/lib/auth-flow.js`
- Modify: `src/main.js`
- Test: `test/auth-flow.test.js`

**Interfaces:**
- Produces: `oauthRedirectStarted(result): boolean`

- [ ] Write a failing test proving an OAuth response containing a URL means navigation started and must not show a session error.
- [ ] Run the focused test and verify the missing helper failure.
- [ ] Implement the helper and use it in staff login.
- [ ] Run the focused test and full frontend suite.
- [ ] Commit the task.

### Task 2: Add secure customer data model

**Files:**
- Create: `supabase/migrations/*_customer_accounts.sql`
- Create: `supabase/tests/customer_accounts.sql`

**Interfaces:**
- Produces: `customer_profiles`, `customer_vehicles`, `appointments.customer_user_id`, ownership RLS, and a customer-readable booking view/query path.

- [ ] Write SQL assertions for schema, grants, RLS ownership policies, and staff/customer separation.
- [ ] Generate a migration with the Supabase CLI.
- [ ] Add tables, appointment ownership, indexes, grants, and explicit policies.
- [ ] Verify migration syntax and security assertions against the linked project or local database when available.
- [ ] Commit the task.

### Task 3: Link authenticated web bookings safely

**Files:**
- Modify: `src/lib/public-booking.js`
- Modify: `bot-ts/api/public/_shared.ts`
- Modify: `bot-ts/api/public/book.ts`
- Modify: `bot-ts/src/supabase-booking.ts`
- Modify: generated customer-account migration
- Test: `bot-ts/test/customer-auth.test.ts`

**Interfaces:**
- Consumes: optional browser access token and `appointments.customer_user_id`.
- Produces: verified optional `customerUserId` passed into `reserveSupabaseAppointment` and the atomic booking function.

- [ ] Write failing tests for bearer parsing and guest/authenticated behavior.
- [ ] Run tests and verify expected failures.
- [ ] Add Authorization CORS support, verify the token server-side, and pass only the verified id to the atomic booking writer.
- [ ] Update the atomic function without changing guest behavior.
- [ ] Run bot and frontend tests.
- [ ] Commit the task.

### Task 4: Customer authentication and account UI

**Files:**
- Modify: `src/lib/supabase.js`
- Create: `src/lib/customer-account.js`
- Modify: `src/main.js`
- Modify: `src/style.css`
- Test: `test/customer-account.test.js`

**Interfaces:**
- Consumes: Supabase Auth and customer-owned tables.
- Produces: email sign-up/sign-in, generic forgot-password request, reset-password completion, profile editing, saved-vehicle CRUD, upcoming/history display, and booking-form prefilling.

- [ ] Write failing tests for account route detection, booking grouping, profile defaults, and recovery callback routing.
- [ ] Run focused tests and verify expected failures.
- [ ] Add customer auth/data functions and account screens.
- [ ] Keep guest booking CTA and flow available; prefill details only when a customer is signed in.
- [ ] Run the complete test suites and production builds.
- [ ] Commit the task.

### Task 5: Deployment verification

**Files:**
- Modify documentation only if configuration requirements differ from current production settings.

**Interfaces:**
- Consumes: migration and application commits.
- Produces: verified branch ready for merge; production deployment remains a separate external side effect.

- [ ] Run all frontend and bot tests and builds.
- [ ] Run Supabase advisors and verify required redirect URLs (`https://washcar.my/`) when connected.
- [ ] Review the complete branch for security and regressions.
- [ ] Present merge/deploy status and any external configuration action still required.
