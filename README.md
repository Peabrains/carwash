# Docket / WashPoint

Firebase-backed car-wash operations and booking platform. WashPoint is the first tenant; the Phase 1 foundation allows the same deployment to house additional providers and locations safely.

## Live components

- Staff PWA: Firebase Hosting, Vite and vanilla JavaScript
- Authentication: Firebase Authentication with Google sign-in
- Operational database: Cloud Firestore
- Customer booking: Tier1 Telegram bot on Vercel
- Bot session state: Firestore, surviving deployments and server restarts
- Trusted server access: Firebase Admin credentials stored only in Vercel

## Tenant model

Every operational record contains both `provider_id` and `location_id`:

- `providers/{providerId}` — operator/business identity
- `locations/{locationId}` — physical outlet and timezone
- `staff/{email}` — role and provider/location access
- `services`, `bays`, `booking_settings`, `appointments`, `blackout_dates`, `bay_closures`, and `crew_break_schedule` — location-scoped operations
- `booking_day_locks` — server transaction locks that serialize competing bookings for a bay/day
- `chat_*` — Firebase Admin-only durable Chat SDK state

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

Copy `.env.example` to `.env` and fill in the Firebase web configuration. Without it, the UI uses local mock catalogue data.

Bot development lives in `bot-ts`:

```bash
npm --prefix bot-ts install
npm --prefix bot-ts test
npm --prefix bot-ts run typecheck
```

The Vercel bot requires `FIREBASE_SERVICE_ACCOUNT_JSON`, Telegram credentials, and `TIER1_PROVIDER_ID` / `TIER1_LOCATION_ID`. `APPOINTMENTS_API_SECRET` protects the private server booking endpoint.

## Switching Supabase accounts/projects

The live app currently runs on Firebase. Supabase is being kept as a migration target, so its credentials are isolated from the working Firebase `.env`.

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

`use` creates `.env.supabase.active` for local tooling only; it does not change the Firebase `.env`. `run` is safer for one-off migration commands because the selected profile is passed only to that command. Account login itself remains separate: if the two projects belong to different Supabase accounts, complete the Supabase OAuth login for the intended account before using its dashboard or connector.

## Booking guarantees

Confirmation runs in a Firestore transaction. It re-reads the live service, settings, bays, appointments, blackout dates, breaks, and outages. A deterministic request ID prevents duplicate confirmation, while a per-bay/day lock prevents two concurrent customers from taking an overlapping slot.

## Legacy archive

The `bot/` Python prototype and `supabase/schema.sql` are retained as historical migration references only. They are not part of the Firebase/Vercel production runtime.
