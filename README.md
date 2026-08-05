# Wash Point

Car wash appointment booking PWA — 2–4 bays, customer self-booking, phone-OTP login,
wash history, and a staff console for the bay board and booking-window settings.

## Status

Scaffold stage. Runs fully on mock data with no setup (see below). Wiring to a real
Supabase project and a Malaysian payment gateway are the two remaining steps before
this is production-ready — see "Open items" at the bottom.

## Stack

- **Frontend**: Vite + vanilla JS, installable as a PWA (`vite-plugin-pwa`)
- **Backend**: Supabase (Postgres + Auth). Schema in `supabase/schema.sql`
- **Payments**: not yet wired — Stripe was ruled out for the Malaysian market
  (no DuitNow QR / Touch 'n Go / GrabPay); candidates are Billplz, Curlec, or HitPay

## Running locally

```bash
npm install
npm run dev
```

Without a `.env` file, the app runs entirely on mock data (`src/lib/api.js`), so you
can click through the whole flow — including the staff console — with nothing
configured. This is intentional: the frontend and data layer are decoupled so UI work
doesn't block on backend setup.

## Connecting a real Supabase project

1. Create a project at supabase.com
2. Run `supabase/schema.sql` in the SQL editor (creates tables, RLS policies, and a
   default `booking_settings` row)
3. Copy `.env.example` to `.env` and fill in your project URL + anon key
4. Enable phone auth (SMS OTP) under Authentication → Providers in the Supabase
   dashboard — this requires configuring an SMS provider (Twilio, MessageBird, etc.)

## Routes

| Route | Screen |
|---|---|
| `#/login` | Phone OTP sign-in |
| `#/services` | Service picker |
| `#/slots` | Date + time slot picker (merged across all active bays) |
| `#/confirm` | Booking confirmation |
| `#/history` | Customer wash history |
| `#/staff/board` | Staff bay status board |
| `#/staff/settings` | Booking window configuration (lead time, advance window, hours) |

Staff routes have no access control yet — see Open items.

## Data model

See `supabase/schema.sql` for the full definition. Key decisions:

- **Wash history is not a separate table** — it's `appointments` filtered by
  `status = 'completed'`, so there's one source of truth.
- **Bay availability has two layers**: `bays.is_active` (indefinite on/off) and
  `bay_closures` (planned, time-ranged closures). A bay going down mid-shift with
  existing bookings against it is handled by `reportBayDown()` in `src/lib/api.js`,
  which tries to auto-reassign affected bookings to another bay with a free slot, and
  flags anything it can't reassign (`needs_attention = true`) for a staff member to
  resolve manually — reschedule or cancel, never auto-cancelled.
- **Booking window is relative, not fixed** — `min_lead_minutes` +
  `max_advance_days`, rather than a fixed start/end calendar range, so it doesn't need
  manual monthly extension.

## Open items

- [ ] Payment gateway integration (Billplz/Curlec/HitPay) — Checkout on `#/slots` →
      `#/confirm`, webhook to flip `payment_status`
- [ ] Staff auth/role separation — `#/staff/*` routes are currently unprotected
- [ ] `getAvailableSlots` should respect `bay_closures`, `blackout_dates`, and
      `booking_settings` hours — current implementation is a simplified version
- [ ] SMS notifications (booking confirmation, reminder, bay-reassignment notice)
- [ ] Vehicle save/select step in the booking flow (schema supports it; UI doesn't
      use it yet)
- [ ] PDPA-facing copy: what's collected, retention policy, deletion request path
