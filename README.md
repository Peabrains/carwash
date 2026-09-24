# Docket / WashPoint

Supabase-backed car-wash marketplace and operations platform. WashPoint is the first tenant; the multi-provider foundation allows the same deployment to house additional providers and locations safely.

## Live components

- Staff/customer PWA: GitHub Pages, Vite and vanilla JavaScript
- Authentication and operational database: Supabase Auth and Postgres
- Customer booking: Tier1 Telegram bot on Vercel
- Bot session state: Supabase Postgres, surviving deployments and server restarts
- Trusted server access: Supabase service-role credentials stored only in Vercel

## Tenant model

Every operational record contains both `provider_id` and `location_id`:

- `providers/{providerId}` — operator/business identity
- `locations/{locationId}` — physical outlet and timezone
- `staff/{email}` — role and provider/location access
- `services`, `bays`, `booking_settings`, `appointments`, `blackout_dates`, `bay_closures`, and `crew_break_schedule` — location-scoped operations
- `booking_day_locks` — server transaction locks that serialize competing bookings for a bay/day
- `chat_*` — server-only durable Chat SDK state

Legacy WashPoint data uses `washpoint` and `washpoint-main`. Staff records without explicit tenant IDs are treated as legacy WashPoint staff during migration.

## Staff roles

- `platform_owner` — manages all providers and locations
- `owner` — manages a provider and its locations/staff
- `manager` — manages operational setup for accessible locations
- `worker` — board access only

Portal routes:

- `#/staff/login`
- `#/staff/board`
- `#/staff/settings`
- `#/staff/organization`

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` and fill in the Supabase URL and publishable key.

Bot development lives in `bot-ts`:

```bash
npm --prefix bot-ts install
npm --prefix bot-ts test
npm --prefix bot-ts run typecheck
```

The Vercel bot requires Supabase server credentials, Telegram credentials, `TIER1_PROVIDER_ID` / `TIER1_LOCATION_ID`, and a random `BOOKING_NOTIFICATION_CRON_SECRET`. The same cron secret must be stored in both Vercel Production and the GitHub Actions repository secrets. GitHub calls the protected reminder endpoint every 10 minutes; failed runs are visible under Actions.

## Switching Supabase accounts/projects

Supabase is the production source of truth for authentication, catalogue, availability, bookings, operations, and platform administration.

Create one local profile per Supabase account/project:

```bash
cp config/supabase/account-a.example.env config/supabase/account-a.env
cp config/supabase/account-b.example.env config/supabase/account-b.env
```

Fill each profile with that project’s URL, project ref, and publishable key. Do not put a `service_role` key in a browser profile, and do not commit the `.env` files.

Useful commands:

```bash
node scripts/supabase-profile.mjs list
node scripts/supabase-profile.mjs show account-a
node scripts/supabase-profile.mjs use account-a
node scripts/supabase-profile.mjs run account-b -- supabase projects list
```

`use` creates `.env.supabase.active` for local tooling only. `run` is safer for one-off commands because the selected profile is passed only to that command.

## Booking guarantees

Confirmation runs through Supabase's atomic booking RPC. It re-checks the live service, settings, bays, appointments, blackout dates, breaks, and closures. A deterministic request ID prevents duplicate confirmation, while the database transaction prevents two concurrent customers from taking an overlapping slot.

Customer cancellation and rescheduling also use atomic Supabase functions. A customer must match the booking phone number, and each provider/location can control the minimum online-change notice period with `booking_settings.customer_change_notice_minutes`.

Telegram confirmations, reschedule/cancellation messages, and 24-hour/2-hour reminders are stored in `booking_notifications` before delivery. The sender claims rows atomically, retries temporary failures, and stops after four attempts. `/api/health` reports missing reminder configuration and an excessive failed-message count without exposing customer data.

## Production checklist and known blockers

- `BOOKING_NOTIFICATION_CRON_SECRET` is configured in Vercel Production. Add the same value as the GitHub Actions repository secret before enabling the reminder schedule; this remains pending until GitHub CLI authentication is restored.
- Supabase leaked-password protection must be enabled in the Account B Auth password settings when the project plan exposes that control. Until then, the related advisor warning is acknowledged as a plan limitation.
- Production catalogue checks and live booking lifecycle tests are intentionally deferred. Use only a dedicated test appointment when those checks are approved; never modify a real customer booking.

## Legacy archive

The `bot/` Python prototype and migration scripts are retained as historical references only. The production runtime uses Supabase, GitHub Pages, and Vercel.
