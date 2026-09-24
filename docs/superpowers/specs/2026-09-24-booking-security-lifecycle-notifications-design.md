# Booking Security, Changes, and Reminders Design

## Goal

Make Docket safer and more dependable before real customers use it:

1. lock down privileged Supabase operations;
2. make customer cancellation and rescheduling consistent and atomic;
3. send dependable Telegram confirmations and reminders without duplicates.

## Current State

- Supabase is the production database and authentication system.
- Web and Telegram customers can already create bookings.
- Web and Telegram management flows can already look up, cancel, and reschedule bookings.
- Rescheduling uses an atomic database function, but cancellation is currently a direct update followed by a separate history insert.
- The online-change cutoff is hard-coded to one hour.
- Booking confirmations are shown in the current conversation or web page, but there is no durable reminder queue.
- Supabase advisors report privileged public functions, overlapping read policies, and disabled leaked-password protection.

## User Experience

### Booking confirmation

After a successful Telegram booking, the customer receives the existing confirmation with service, date, time, and reference number. A durable notification record is also created so delivery can be audited without sending a duplicate confirmation.

After a successful web booking, the customer sees the existing confirmation page. The notification system records the event, but it does not attempt Telegram delivery unless the booking has a Telegram chat ID.

### Reminders

Telegram bookings receive:

- one reminder approximately 24 hours before the appointment;
- one reminder approximately 2 hours before the appointment.

Each reminder includes the provider, location, service, date, time, vehicle, and booking reference. Cancelled, completed, no-show, or already-started bookings are never reminded.

### Cancellation and rescheduling

Customers continue using the existing website and Telegram commands. The system rejects changes when a booking is:

- already cancelled;
- completed or marked no-show;
- in the past;
- inside the location's online-change cutoff.

Each location receives a configurable `customer_change_notice_minutes` setting. Existing locations default to 60 minutes, preserving current behavior.

Successful cancellation or rescheduling creates a booking-history event and queues a customer notification in the same database transaction as the appointment change.

## Security Design

### Database functions

- Anonymous users receive no execution access to privileged database functions.
- Browser staff receive access only to the public wrapper functions their screens use.
- Every public staff wrapper verifies the signed-in staff member, active status, role, provider, and location before doing privileged work.
- Internal authorization helpers move to a non-exposed `private` schema and use an empty pinned search path with fully qualified object names.
- Obsolete privileged functions are revoked or removed after verifying that no current reader calls them.
- Service-role-only booking functions remain unavailable to browser roles.

### Row-level security

Read and write policies are separated. A broad `FOR ALL` policy will not also perform reads when a dedicated read policy exists. Provider and location boundaries remain enforced for every staff role.

### Password protection

Leaked-password protection is enabled when the current Supabase subscription supports it. If the account plan does not support it, the project keeps its existing minimum password length and records the upgrade requirement as an explicit production blocker rather than pretending the warning is fixed.

## Booking Change Design

Two service-role database functions own customer changes:

- `cancel_public_appointment_atomic(...)`
- the existing `reschedule_appointment_atomic(...)`, extended to enforce customer-change rules and write history/notifications atomically.

The Vercel API verifies the customer's reference and normalized phone number before calling either function. Lookup responses never expose unrelated customer records.

The cancellation transaction:

1. locks the appointment row;
2. validates current status and notice period;
3. changes status to `cancelled`;
4. inserts a booking-history event;
5. queues one cancellation notification;
6. commits everything together or rolls everything back.

The rescheduling transaction follows the existing bay/day locking behavior, then updates the appointment, writes history, invalidates obsolete reminders, and queues one rescheduling notification in the same transaction.

## Notification Design

### Durable queue

A `booking_notifications` table stores:

- appointment, provider, and location IDs;
- notification type;
- channel;
- scheduled delivery time;
- recipient chat ID;
- status: `pending`, `processing`, `sent`, `failed`, or `cancelled`;
- attempt count, last error, sent time, and timestamps;
- a unique idempotency key.

The table is protected with RLS. Browser users cannot insert or send notifications. Authorized staff may read delivery status for their provider; only the trusted server changes delivery state.

### Queue creation

Booking creation queues the 24-hour and 2-hour reminders. Cancellation cancels pending reminders and queues a cancellation message. Rescheduling cancels reminders for the old time and creates reminders for the new time plus a changed-booking message.

Unique idempotency keys prevent repeated API calls from creating duplicate messages.

### Sender

A protected Vercel endpoint runs on a schedule. It atomically claims a small batch of due notifications, sends them through Telegram, and records success or failure.

- Temporary failures are retried with a delay.
- A notification stops retrying after a bounded number of attempts.
- Missing chat IDs are marked cancelled, not failed.
- Logs contain booking references and notification IDs, never bot tokens or full customer phone numbers.

The scheduler authenticates with a dedicated random secret stored only in Vercel and GitHub Actions. The existing health endpoint remains separate.

## Schema and Rollout

The change uses an expand-first migration:

1. add the private schema, settings column, queue table, indexes, grants, and new functions;
2. keep the existing public API request and response shapes working;
3. deploy server code that uses the new functions and queue;
4. verify web booking management, Telegram management, staff access, and notification delivery;
5. revoke obsolete function access only after the new path passes production checks.

No appointments or booking history are deleted. Existing bookings receive reminders only if they are still upcoming and have a Telegram chat ID; a one-time idempotent queue backfill may create missing reminder rows.

## Rollback

- Disable the scheduled sender first.
- Revert the Vercel API to the previous booking-management implementation if necessary.
- Keep new additive columns and queue rows; they are harmless while unused.
- Restore previous grants only for a confirmed staff-access regression and only for the exact affected function.
- Never delete appointment or booking-history data during rollback.

## Testing and Acceptance

### Security

- Anonymous callers cannot execute privileged staff or booking functions.
- Workers cannot perform owner/manager writes.
- Staff cannot read or alter another provider's data.
- Owners and managers retain the intended operations for their own provider/location.
- Supabase security and performance advisors are rerun and every remaining warning is either fixed or documented as intentional with evidence.

### Booking changes

- Correct reference and phone can retrieve a booking.
- Incorrect customer details reveal no booking.
- Valid upcoming bookings can be cancelled and rescheduled.
- Past, completed, no-show, cancelled, and too-close bookings cannot change.
- Concurrent rescheduling and new booking attempts cannot double-book a bay.
- Appointment change, history event, and notification queue either all succeed or all fail.

### Notifications

- New Telegram bookings receive no duplicate confirmation/reminder records.
- Reminders are sent once at the intended windows.
- Cancellation stops future reminders.
- Rescheduling replaces old reminders with new ones.
- Failed Telegram sends retry and become visible in delivery status.
- Web bookings without Telegram chat IDs do not generate repeated failures.

## Out of Scope

- WhatsApp, SMS, and email delivery;
- marketing campaigns;
- payment/deposit notifications;
- customer accounts and saved vehicles;
- changes to production catalogue content.
