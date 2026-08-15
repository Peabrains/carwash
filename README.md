# Wash Point

Car wash appointment booking system — 2–4 bays, staggered crew rest breaks, and a
staff PWA for the bay board and booking-window settings. Customers book via
Telegram/WhatsApp, not this app — see "Architecture" below.

## Status

Schema and staff-facing PWA are wired to a real Supabase project. The customer
booking bot (Telegram/WhatsApp) is a separate, not-yet-built piece — see "Open items."

## Architecture

- **Customers never use this PWA.** They book by messaging a Telegram/WhatsApp bot,
  which writes directly to the `appointments` table using Supabase's `service_role`
  key (bypasses RLS, since the bot is a trusted server-side process).
- **This PWA is staff/owner-only.** Staff sign in with a magic link (passwordless);
  access is gated by a `staff` table with `owner` (full access) and `worker`
  (read-only bookings, for seeing the day's schedule) roles.
- **Frontend**: Vite + vanilla JS, installable as a PWA (`vite-plugin-pwa`)
- **Backend**: Supabase (Postgres + Auth). Schema in `supabase/schema.sql`

## Running locally

```bash
bun install   # or npm install
bun run dev   # or npm run dev
```

Without a `.env` file, the app runs entirely on mock data (`src/lib/api.js`), so you
can click through the staff console with nothing configured.

## Connecting a real Supabase project

1. Create a project at supabase.com
2. Run `supabase/schema.sql` in the SQL editor (creates tables and RLS policies)
3. Copy `.env.example` to `.env` and fill in your project URL + anon/publishable key
4. Enable email auth (magic link) under Authentication → Providers
5. **Bootstrap the first owner manually** — sign in once via the app's magic link to
   create the `auth.users` row, then insert a matching row into `staff` with
   `role = 'owner'` directly via the SQL editor (RLS intentionally blocks any
   self-service way to grant yourself staff access — there's no bootstrapping
   path around it by design)

## Routes

| Route | Screen |
|---|---|
| `#/staff/login` | Staff magic-link sign-in |
| `#/staff/board` | Staff bay status board (owner + worker) |
| `#/staff/settings` | Booking window, buffer time, and crew break configuration (owner only) |

## Data model

See `supabase/schema.sql` for the full definition. Key decisions:

- **Customer identity is a chat_id, not a Supabase Auth account** — `appointments`
  stores `customer_chat_id` + `channel` (telegram/whatsapp) directly, since booking
  happens through the messaging bot, not an in-app login.
- **Bay availability has two layers**: `bays.is_active` (indefinite on/off) and
  `bay_closures` (planned, time-ranged closures). A bay going down mid-shift with
  existing bookings against it is handled by `reportBayDown()` in `src/lib/api.js`,
  which tries to auto-reassign affected bookings to another bay with a free slot, and
  flags anything it can't reassign (`needs_attention = true`) for a staff member to
  resolve manually — reschedule or cancel, never auto-cancelled.
- **Crew rest breaks are a recurring daily pattern, not manual entry** —
  `crew_break_schedule` holds one row per bay (a daily start time + duration).
  Rather than requiring staff to re-add a closure every single day, the availability
  check resolves each day's actual break window from this pattern at query time,
  the same way it already treats `bay_closures`. Stagger break times per bay outside
  your peak hours so bays don't all lose capacity simultaneously.
- **Buffer time is applied at query time, not stored per booking** — booking
  conflicts extend each *existing* appointment's occupied window by
  `booking_settings.buffer_minutes` when checking for overlaps. This is intentionally
  one-sided (only the existing booking's end is extended, not the candidate's own
  window) so back-to-back bookings separated by exactly one buffer never get
  double-counted.
- **Booking window is relative, not fixed** — `min_lead_minutes` +
  `max_advance_days`, rather than a fixed start/end calendar range, so it doesn't need
  manual monthly extension.

## Open items

- [ ] The Telegram/WhatsApp booking bot itself — nothing customer-facing exists yet,
      only the schema and staff console it'll write into
- [ ] Payment gateway integration (Billplz/Curlec/HitPay) — Stripe was ruled out for
      the Malaysian market (no DuitNow QR / Touch 'n Go / GrabPay)
- [ ] `getAvailableSlots` still uses a hardcoded 9am–7pm scan window and doesn't yet
      respect `weekday_open/close`, `weekend_open/close`, or `blackout_dates` — a
      pre-existing simplification, unrelated to the buffer/crew-break work
- [ ] Vehicle plate is a freeform field on the appointment now (no separate
      `vehicles` table) since it was tied to the removed customer-account login
- [ ] SMS/WhatsApp notifications (booking confirmation, reminder, bay-reassignment
      notice)
- [ ] PDPA-facing copy: what's collected, retention policy, deletion request path
