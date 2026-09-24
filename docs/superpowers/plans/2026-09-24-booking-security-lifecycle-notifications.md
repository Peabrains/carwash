# Booking Security, Changes, and Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure privileged Supabase operations, make customer cancellation/rescheduling atomic, and deliver reliable Telegram confirmations and reminders.

**Architecture:** Add one expand-first Supabase migration for private authorization helpers, clean RLS policies, customer-change rules, and a durable notification queue. Keep the existing web and Telegram request shapes, route all mutations through atomic database functions, and process due notifications through a secret-protected Vercel endpoint invoked by GitHub Actions.

**Tech Stack:** Supabase Postgres/Auth/RLS, TypeScript, Vercel Functions, Telegram Bot API, GitHub Actions, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-24-booking-security-lifecycle-notifications-design.md`

## Global Constraints

- Preserve every existing appointment and booking-history row.
- Existing locations default to a 60-minute online-change cutoff.
- Reminders run approximately 24 hours and 2 hours before appointments.
- Telegram is the only automatic delivery channel in this release.
- Service-role and Telegram secrets remain server-only.
- Public API request and response shapes remain backward compatible.
- Every state-changing operation is idempotent and transaction-safe.
- Rollout is expand, deploy, verify, then revoke obsolete access.

## Review Focus

- A guessed reference or wrong phone number must reveal no customer or booking data.
- Concurrent booking and rescheduling must never assign overlapping appointments to one bay.
- Repeated queue/sender calls must not create or send duplicate notifications.
- Cancelling or rescheduling must invalidate reminders for the old appointment state.
- Staff from one provider must never read or mutate another provider's rows.

---

### Task 1: Create the Supabase migration and security regression queries

**Files:**
- Create via CLI: `supabase/migrations/<CLI timestamp>_booking_security_notifications.sql`
- Create: `supabase/tests/booking_security_notifications.sql`
- Modify: `supabase/tenant-rls.sql`
- Modify: `supabase/fix-staff-rls-recursion.sql`
- Modify: `supabase/staff-invitations.sql`
- Modify: `supabase/provider-operations.sql`

**Interfaces:**
- Consumes: existing `staff`, `appointments`, `booking_settings`, and `booking_events` tables.
- Produces: private authorization helper functions and non-overlapping provider-scoped policies.

- [ ] **Step 1: Create the migration using the Supabase CLI**

Run through the Account B workspace wrapper:

```bash
node /Users/qingdekueh/github/.tools/supabase-workspace/supabase-workspace.mjs run carwash -- npx supabase migration new booking_security_notifications
```

Use the exact migration path printed by the CLI for all migration edits below.

- [ ] **Step 2: Write security regression SQL before changing policies**

Create `supabase/tests/booking_security_notifications.sql` with assertions that query `information_schema.routine_privileges` and `pg_policies`:

```sql
begin;

do $$
begin
  if exists (
    select 1
    from information_schema.routine_privileges
    where routine_schema = 'public'
      and grantee in ('PUBLIC', 'anon')
      and privilege_type = 'EXECUTE'
      and routine_name in (
        'current_staff_context',
        'invite_staff_member',
        'accept_staff_invitation',
        'revoke_staff_access',
        'upsert_staff_member_by_email',
        'reserve_appointment_atomic',
        'reschedule_appointment_atomic'
      )
  ) then
    raise exception 'Privileged function remains executable by PUBLIC or anon';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and cmd = 'ALL'
      and tablename in (
        'appointments', 'bay_closures', 'bays', 'blackout_dates',
        'booking_settings', 'crew_break_schedule', 'locations', 'services'
      )
  ) then
    raise exception 'Broad ALL policy still overlaps dedicated read policy';
  end if;
end
$$;

rollback;
```

- [ ] **Step 3: Verify the regression query fails against the current production schema**

Run it with a production-safe read-only transaction through the workspace wrapper. Expected: failure identifying at least one current privilege or overlapping policy.

- [ ] **Step 4: Add a private authorization schema and helper**

In the generated migration:

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.current_staff_context()
returns table (staff_id uuid, provider_id text, location_id text, role text, is_active boolean)
language sql
security definer
stable
set search_path = ''
as $$
  select s.id, s.provider_id, s.location_id, s.role, s.is_active
  from public.staff s
  where s.id = (select auth.uid())
  limit 1
$$;

revoke all on function private.current_staff_context() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_staff_context() to authenticated;
```

Update policies that currently call `public.current_staff_context()` to call `private.current_staff_context()`. Revoke and drop the public helper after the policy replacement.

- [ ] **Step 5: Separate read and write RLS policies**

For each affected table, replace `FOR ALL` management policies with explicit `INSERT`, `UPDATE`, and `DELETE` policies. Preserve the current provider, location, active-staff, and role predicates. Example for appointments:

```sql
drop policy if exists appointments_manage_scoped on public.appointments;

create policy appointments_insert_scoped on public.appointments
for insert to authenticated
with check (exists (
  select 1 from private.current_staff_context() me
  where me.is_active
    and me.role in ('platform_owner', 'owner', 'manager')
    and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)
    and (me.location_id is null or me.location_id = appointments.location_id)
));

create policy appointments_update_scoped on public.appointments
for update to authenticated
using (exists (
  select 1 from private.current_staff_context() me
  where me.is_active
    and me.role in ('platform_owner', 'owner', 'manager')
    and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)
    and (me.location_id is null or me.location_id = appointments.location_id)
))
with check (exists (
  select 1 from private.current_staff_context() me
  where me.is_active
    and me.role in ('platform_owner', 'owner', 'manager')
    and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)
    and (me.location_id is null or me.location_id = appointments.location_id)
));

create policy appointments_delete_scoped on public.appointments
for delete to authenticated
using (exists (
  select 1 from private.current_staff_context() me
  where me.is_active
    and me.role in ('platform_owner', 'owner', 'manager')
    and (me.role = 'platform_owner' or me.provider_id = appointments.provider_id)
    and (me.location_id is null or me.location_id = appointments.location_id)
));
```

- [ ] **Step 6: Harden privileged function grants**

For each privileged function, set `search_path = ''`, schema-qualify every table/function reference, revoke from `PUBLIC` and `anon`, and grant only the required role. Remove the obsolete `upsert_staff_member_by_email` function after confirming `rg` finds no caller. Keep public staff RPC wrappers callable by `authenticated` because they perform explicit actor/tenant checks; document any resulting advisor warning as intentional.

- [ ] **Step 7: Apply the migration to Account B and run security checks**

Apply through the workspace wrapper, run `supabase/tests/booking_security_notifications.sql`, then test one allowed staff read and one denied cross-provider read.

- [ ] **Step 8: Commit Task 1**

```bash
git add supabase/migrations supabase/tests supabase/tenant-rls.sql supabase/fix-staff-rls-recursion.sql supabase/staff-invitations.sql supabase/provider-operations.sql
git commit -m "fix: harden Supabase staff permissions"
```

### Task 2: Add atomic customer booking changes and notification storage

**Files:**
- Modify: generated `supabase/migrations/<CLI timestamp>_booking_security_notifications.sql`
- Modify: `supabase/booking-atomic.sql`
- Modify: `supabase/booking-history.sql`
- Modify: `supabase/tests/booking_security_notifications.sql`

**Interfaces:**
- Produces: `cancel_public_appointment_atomic(uuid)`, extended `reschedule_appointment_atomic(uuid,date,text,uuid)`, `booking_notifications`, and `queue_booking_notifications(uuid,text)`.
- Consumers: trusted Vercel APIs using the service role.

- [ ] **Step 1: Add failing lifecycle assertions**

Extend the SQL test to assert:

```sql
select 1 / case when exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_settings'
    and column_name = 'customer_change_notice_minutes'
) then 1 else 0 end;

select 1 / case when exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'booking_notifications'
) then 1 else 0 end;
```

Expected before implementation: failure.

- [ ] **Step 2: Add the configurable change cutoff**

```sql
alter table public.booking_settings
  add column if not exists customer_change_notice_minutes integer not null default 60
  check (customer_change_notice_minutes >= 0 and customer_change_notice_minutes <= 10080);
```

- [ ] **Step 3: Create the durable notification table**

```sql
create table if not exists public.booking_notifications (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(id) on delete cascade,
  location_id text not null references public.locations(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  notification_type text not null check (notification_type in ('confirmed','reminder_24h','reminder_2h','cancelled','rescheduled')),
  channel text not null default 'telegram' check (channel in ('telegram')),
  recipient_chat_id text,
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0,
  idempotency_key text not null unique,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index booking_notifications_due_idx
  on public.booking_notifications(status, scheduled_for)
  where status in ('pending','failed');

alter table public.booking_notifications enable row level security;
```

Add provider-scoped staff `SELECT` only. Revoke direct inserts/updates/deletes from browser roles.

- [ ] **Step 4: Add idempotent queue creation**

Create a service-role-only function that inserts confirmation/change events immediately and reminders at `scheduled_at - interval '24 hours'` and `scheduled_at - interval '2 hours'`. Use `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Do not queue past reminder times or rows without a Telegram chat ID.

- [ ] **Step 5: Make cancellation atomic**

Create `cancel_public_appointment_atomic(p_appointment_id uuid)` as `SECURITY DEFINER`, service-role-only. It must lock the appointment, reject invalid status/past/cutoff cases, update the status, insert the booking event, cancel pending reminders, queue one cancellation notification, and return the updated appointment ID/status.

- [ ] **Step 6: Extend rescheduling atomically**

Keep existing advisory/day locking and availability checks. Add status/past/cutoff validation, insert the reschedule history event, cancel pending reminders for the old schedule, and queue new reminder/change rows before returning.

- [ ] **Step 7: Queue notifications from booking creation**

At the end of `reserve_appointment_atomic`, call the queue helper after the appointment insert. Use the inserted appointment ID instead of searching by reference.

- [ ] **Step 8: Test rollback and idempotency**

Within a transaction, verify duplicate queue calls leave one row per idempotency key, cancellation removes pending reminders, rescheduling replaces reminder keys, and a forced history insert failure rolls back the appointment mutation.

- [ ] **Step 9: Commit Task 2**

```bash
git add supabase/migrations supabase/tests supabase/booking-atomic.sql supabase/booking-history.sql
git commit -m "feat: add atomic booking changes and notification queue"
```

### Task 3: Route public booking management through atomic functions

**Files:**
- Modify: `bot-ts/src/supabase-booking.ts`
- Modify: `bot-ts/api/public/manage.ts`
- Create: `bot-ts/test/public-booking-rules.test.ts`

**Interfaces:**
- Consumes: `cancel_public_appointment_atomic` and extended `reschedule_appointment_atomic`.
- Preserves: `POST /api/public/manage` request and `{ booking }` response.

- [ ] **Step 1: Write failing unit tests for public verification and status rules**

Extract pure helpers and test normalized Malaysian phone matching, plate normalization, past booking rejection, completed/no-show/cancelled rejection, and exact cutoff boundary behavior.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { canCustomerChangeBooking, customerIdentityMatches } from "../src/public-booking-rules.js";

test("customer identity requires normalized phone plus reference or name and plate", () => {
  assert.equal(customerIdentityMatches(
    { reference: "WP-1", customer_phone: "0123456789", customer_name: "Aina", vehicle_plate: "QAA 123" },
    { reference: "WP-1", phone: "+60123456789", name: "", vehiclePlate: "" }
  ), true);
});

test("change is rejected exactly inside the location cutoff", () => {
  assert.equal(canCustomerChangeBooking({ status: "confirmed", scheduledAt: "2026-09-25T02:00:00Z", noticeMinutes: 60 }, new Date("2026-09-25T01:00:00Z")), false);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run `npm --prefix bot-ts test`. Expected: missing helper module or exports.

- [ ] **Step 3: Implement `public-booking-rules.ts`**

Create normalization and change-eligibility helpers with no database dependency. Return safe user-facing reasons without revealing whether an unmatched booking exists.

- [ ] **Step 4: Replace direct cancellation writes**

In `managePublicBooking`, preserve lookup behavior but call `cancel_public_appointment_atomic` for cancellation and the extended reschedule RPC for moves. Remove the separate appointment update and booking-event inserts.

- [ ] **Step 5: Keep API errors generic where identity fails**

Return the same `404` message for unknown reference, wrong phone, wrong name, and wrong plate. Return `400` only after a booking is authenticated but cannot change due to status, date, cutoff, or availability.

- [ ] **Step 6: Run bot tests and typecheck**

```bash
npm --prefix bot-ts test
npm --prefix bot-ts run typecheck
```

- [ ] **Step 7: Commit Task 3**

```bash
git add bot-ts/src/supabase-booking.ts bot-ts/src/public-booking-rules.ts bot-ts/api/public/manage.ts bot-ts/test/public-booking-rules.test.ts
git commit -m "fix: make customer booking changes atomic"
```

### Task 4: Add the Telegram notification sender

**Files:**
- Create: `bot-ts/src/booking-notifications.ts`
- Create: `bot-ts/api/internal/send-booking-notifications.ts`
- Create: `bot-ts/test/booking-notifications.test.ts`
- Modify: `bot-ts/api/health.ts`

**Interfaces:**
- Produces: `processDueBookingNotifications(limit?: number)` and protected `POST /api/internal/send-booking-notifications`.
- Consumes: `booking_notifications`, appointment/service/location/provider rows, and `TIER1_TELEGRAM_BOT_TOKEN`.

- [ ] **Step 1: Write failing formatter and retry tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatBookingNotification, retryDelayMinutes } from "../src/booking-notifications.js";

test("24 hour reminder includes reference, provider, location and vehicle", () => {
  const text = formatBookingNotification("reminder_24h", {
    reference: "WP-ABC", providerName: "WashPoint", locationName: "Main",
    serviceName: "Premium Wash", scheduledAt: "2026-09-25T02:00:00Z",
    vehiclePlate: "QAA 123"
  });
  assert.match(text, /WP-ABC/);
  assert.match(text, /WashPoint/);
  assert.match(text, /QAA 123/);
});

test("retry delay grows but remains bounded", () => {
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMinutes), [5, 15, 60, 360]);
});
```

- [ ] **Step 2: Implement pure formatting and retry rules**

Support `confirmed`, `reminder_24h`, `reminder_2h`, `cancelled`, and `rescheduled`. Redact phone numbers from logs and messages unless required by the customer-facing copy.

- [ ] **Step 3: Implement atomic batch claiming**

Add a service-role function `claim_due_booking_notifications(p_limit integer)` using `FOR UPDATE SKIP LOCKED`. It changes claimed rows to `processing`, increments attempts, and returns only due Telegram rows. A second invocation cannot claim the same row.

- [ ] **Step 4: Send through Telegram and persist outcomes**

Call `https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id` and formatted text. On success mark `sent`. On temporary failure schedule a retry. After four attempts mark `failed`. Missing chat IDs become `cancelled`.

- [ ] **Step 5: Protect the internal endpoint**

Require `Authorization: Bearer ${BOOKING_NOTIFICATION_CRON_SECRET}` using constant-time comparison. Return `401` for missing/wrong secrets and a count summary for successful runs. Never return notification payloads or secrets.

- [ ] **Step 6: Extend health checks**

Report whether the cron secret is configured and whether failed notification rows exceed a small threshold. Do not expose customer details.

- [ ] **Step 7: Run tests and typecheck**

```bash
npm --prefix bot-ts test
npm --prefix bot-ts run typecheck
```

- [ ] **Step 8: Commit Task 4**

```bash
git add bot-ts/src/booking-notifications.ts bot-ts/api/internal/send-booking-notifications.ts bot-ts/api/health.ts bot-ts/test/booking-notifications.test.ts supabase/migrations
git commit -m "feat: send durable Telegram booking reminders"
```

### Task 5: Schedule, configure, deploy, and verify

**Files:**
- Create: `.github/workflows/booking-reminders.yml`
- Modify: `.env.example`
- Modify: `bot-ts/.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: production Vercel endpoint and `BOOKING_NOTIFICATION_CRON_SECRET`.
- Produces: scheduled reminder dispatch with visible GitHub run failures.

- [ ] **Step 1: Add the scheduled workflow**

```yaml
name: Send booking reminders

on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

jobs:
  send:
    runs-on: ubuntu-latest
    steps:
      - name: Send due reminders
        env:
          CRON_SECRET: ${{ secrets.BOOKING_NOTIFICATION_CRON_SECRET }}
        run: |
          curl --fail --show-error --silent \
            -X POST \
            -H "Authorization: Bearer ${CRON_SECRET}" \
            https://carwash-bot.vercel.app/api/internal/send-booking-notifications
```

- [ ] **Step 2: Generate and configure one shared random secret**

Generate a 32-byte value, store it in Vercel production as `BOOKING_NOTIFICATION_CRON_SECRET`, and add the same value as a GitHub Actions repository secret. Never print or commit it.

- [ ] **Step 3: Enable leaked-password protection when supported**

Open Supabase Auth password settings for Account B and enable leaked-password protection. If the control is unavailable, record the plan limitation in README production blockers and leave the advisor warning acknowledged.

- [ ] **Step 4: Backfill upcoming Telegram reminders idempotently**

Run the queue helper once for upcoming confirmed Telegram bookings. Verify no web booking without a chat ID produces a pending delivery.

- [ ] **Step 5: Run full local verification**

```bash
npm --prefix bot-ts run typecheck
npm --prefix bot-ts test
npm run build
git diff --check
```

- [ ] **Step 6: Re-run Supabase advisors**

```bash
node /Users/qingdekueh/github/.tools/supabase-workspace/supabase-workspace.mjs run carwash -- npx supabase db advisors --linked --type all --level warn
```

Expected: overlapping permissive-policy and anonymous privileged-function warnings are gone. Any authenticated wrapper warning is documented with its in-function authorization evidence.

- [ ] **Step 7: Deploy and smoke-test**

Deploy `carwash-bot` from the repository root. Verify:

```bash
curl --fail https://carwash-bot.vercel.app/api/health
curl -i -X POST https://carwash-bot.vercel.app/api/internal/send-booking-notifications
```

Expected: health is `200`; unauthenticated sender call is `401`.

- [ ] **Step 8: Run safe production lifecycle tests**

Use a dedicated test appointment to verify lookup, reschedule, cancellation, event history, queued notifications, one successful test Telegram delivery, and cancellation of obsolete reminders. Do not modify a real customer's booking.

- [ ] **Step 9: Commit Task 5 and push**

```bash
git add .github/workflows/booking-reminders.yml .env.example bot-ts/.env.example README.md
git commit -m "chore: schedule booking reminders"
git push origin master
```

## Final Rollback Checklist

- Pause `.github/workflows/booking-reminders.yml` before rolling back sender code.
- Revert Vercel to the previous deployment if API behavior regresses.
- Keep additive columns and `booking_notifications`; do not delete queued history.
- Restore only the exact function grant required for a confirmed staff regression.
- Re-run staff access, booking lookup, and health checks after rollback.
